'use strict';

const Homey = require('homey');
const AquareaClient = require('../../lib/AquareaClient');

// Intervalle de polling par defaut : 5 minutes.
// ⚠️  Volontairement eleve pour eviter le rate-limiting / bannissement d'IP
//     par Aquarea Smart Cloud. Ne PAS descendre sous ce plancher sans raison.
const DEFAULT_POLL_INTERVAL_S = 300;
const MIN_POLL_INTERVAL_S = 60;

// Apres une commande acceptee par le cloud, Aquarea continue de renvoyer
// l'ancienne valeur pendant plusieurs minutes (le gateway ne remonte son etat
// que periodiquement). Sans protection, le poll suivant ecrase la valeur
// choisie dans l'app et l'utilisateur voit la tuile "revenir en arriere".
// On fait donc confiance a la commande : la valeur locale prime jusqu'a ce que
// le cloud la confirme, ou au plus pendant OPTIMISTIC_TTL_MS.
const OPTIMISTIC_TTL_MS = 15 * 60 * 1000;

// Rafraichissement de courtoisie apres une commande. Volontairement long :
// interroger le cloud 5 s apres un ordre ne renvoie que des donnees perimees
// et rapproche du rate-limiting.
const POST_COMMAND_REFRESH_MS = 90 * 1000;

class AquareaDevice extends Homey.Device {

  async onInit() {
    const { id } = this.getData();
    this.deviceId = id;

    this.log(`Aquarea device init: ${this.getName()} (${this.deviceId})`);

    // Instancie le client a partir des identifiants stockes au pairing.
    const username = this.getStoreValue('username');
    const password = this.getStoreValue('password');

    if (!username || !password) {
      this.setUnavailable(this.homey.__('error.missing_credentials'));
      return;
    }

    // Zone active (mise a jour a chaque poll). Defaut : 1.
    this.zoneId = 1;

    // Cache optimiste : capability -> { value, until }. Voir _commit().
    this._optimistic = new Map();

    // Migration : garantit la presence ET l'ordre voulu des capabilities.
    // L'ordre du tableau = l'ordre des tuiles sur la carte (calque sur l'ecran
    // du ballon Aquarea). Homey fige l'ordre des capabilities au moment de leur
    // ajout : pour les appareils deja appaires, il faut donc les retirer puis
    // les re-ajouter dans le bon ordre (les valeurs sont repeuplees au 1er poll).
    const desiredCaps = [
      'thermostat_mode',
      'target_temperature.zone',
      'target_temperature',
      'onoff.tank',
      'onoff.zone',
      'measure_temperature',
      'measure_temperature.zone',
      'measure_temperature.outdoor',
    ];
    const currentCaps = this.getCapabilities();
    const sameOrder = currentCaps.length === desiredCaps.length
      && desiredCaps.every((cap, i) => currentCaps[i] === cap);
    if (!sameOrder) {
      this.log('Reordering capabilities to match tank screen layout');
      for (const cap of currentCaps) {
        try { await this.removeCapability(cap); } catch (err) { this.error(`removeCapability(${cap})`, err.message); }
      }
      for (const cap of desiredCaps) {
        try { await this.addCapability(cap); } catch (err) { this.error(`addCapability(${cap})`, err.message); }
      }
    }

    this.client = new AquareaClient({
      username,
      password,
      log: (...a) => this.log(...a),
      error: (...a) => this.error(...a),
    });

    // Restaure une eventuelle session persistee (tokens + clientId + cookies)
    // pour eviter une re-authentification complete a chaque redemarrage.
    const savedSession = this.getStoreValue('session');
    if (savedSession) this.client.importSession(savedSession);

    // Ecoute des commandes Homey.
    this.registerCapabilityListener('target_temperature', this._onSetTankTemperature.bind(this));
    this.registerCapabilityListener('target_temperature.zone', this._onSetZoneTemperature.bind(this));
    this.registerCapabilityListener('thermostat_mode', this._onCapabilityThermostatMode.bind(this));
    this.registerCapabilityListener('onoff.tank', this._onSetTankOnoff.bind(this));
    this.registerCapabilityListener('onoff.zone', this._onSetZoneOnoff.bind(this));

    // Demarre le moteur de polling.
    this._startPolling();

    // Premier rafraichissement immediat (mais protege).
    this._poll().catch(err => this.error('Initial poll failed:', err.message));
  }

  // =========================================================================
  //  Moteur de polling
  // =========================================================================

  _resolveInterval() {
    let seconds = Number(this.getSetting('poll_interval'));
    if (!Number.isFinite(seconds)) seconds = DEFAULT_POLL_INTERVAL_S;
    if (seconds < MIN_POLL_INTERVAL_S) seconds = MIN_POLL_INTERVAL_S;
    return seconds * 1000;
  }

  _startPolling() {
    this._stopPolling();
    const ms = this._resolveInterval();
    this.log(`Polling every ${ms / 1000}s`);
    this._pollTimer = this.homey.setInterval(() => {
      this._poll().catch(err => this.error('Poll failed:', err.message));
    }, ms);
  }

  _stopPolling() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _cancelRefresh() {
    if (this._refreshTimer) {
      this.homey.clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  /** Recupere l'etat depuis le cloud et synchronise les capabilities. */
  async _poll() {
    if (this._polling) return; // evite le chevauchement de deux polls.
    this._polling = true;

    try {
      const data = await this.client.getDeviceData(this.deviceId);

      if (data.zoneId != null) this.zoneId = data.zoneId;

      // Ajuste une seule fois les plages min/max reelles remontees par l'API.
      await this._applyRanges(data);

      // Ballon (ECS).
      await this._setCapability('measure_temperature', data.tankTemperature);
      await this._setCapability('target_temperature', data.tankTargetTemperature);
      if (data.tankOn !== null) await this._setCapability('onoff.tank', data.tankOn);

      // Zone (chauffage / PAC).
      await this._setCapability('measure_temperature.zone', data.zoneTemperature);
      await this._setCapability('target_temperature.zone', data.zoneHeatSet);
      await this._setCapability('onoff.zone', data.zoneOn);

      // Systeme.
      await this._setCapability('measure_temperature.outdoor', data.outdoorTemperature);
      if (data.thermostatMode) {
        await this._setCapability('thermostat_mode', data.thermostatMode);
      }

      // Persiste la session rafraichie pour survivre aux redemarrages.
      await this.setStoreValue('session', this.client.exportSession());

      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.error('Polling error:', err.message);
      // On garde l'appareil dispo sauf erreur persistante d'auth.
      if (/identifiants|invalid|2FA|authorization code|access token/i.test(err.message)) {
        await this.setUnavailable(this.homey.__('error.connection_failed', { message: err.message }));
      }
    } finally {
      this._polling = false;
    }
  }

  /**
   * Ecrit une capability. Les valeurs venant du cloud (force = false) sont
   * ignorees tant qu'une commande locale recente n'a pas ete confirmee.
   */
  async _setCapability(cap, value, { force = false } = {}) {
    if (value === null || typeof value === 'undefined') return;
    if (!this.hasCapability(cap)) return;
    if (!force && this._isMasked(cap, value)) return;
    try {
      await this.setCapabilityValue(cap, value);
    } catch (err) {
      this.error(`setCapabilityValue(${cap}) failed:`, err.message);
    }
  }

  // =========================================================================
  //  Cache optimiste des commandes
  // =========================================================================

  /**
   * Applique immediatement la valeur commandee et la protege des ecrasements
   * par le cloud. A n'appeler qu'apres l'acquittement de la requete HTTP :
   * hors erreur reseau / applicative, on considere l'ordre comme transmis.
   */
  async _commit(cap, value) {
    if (!this.hasCapability(cap)) return;
    this._optimistic.set(cap, { value, until: Date.now() + OPTIMISTIC_TTL_MS });
    await this._setCapability(cap, value, { force: true });
  }

  /** true si la valeur du cloud doit etre ignoree pour cette capability. */
  _isMasked(cap, incoming) {
    const pending = this._optimistic.get(cap);
    if (!pending) return false;

    if (Date.now() >= pending.until) {
      this.log(`Optimistic value for ${cap} expired, trusting cloud again`);
      this._optimistic.delete(cap);
      return false;
    }
    if (this._sameValue(pending.value, incoming)) {
      // Le cloud a rattrape son retard : le polling reprend la main.
      this._optimistic.delete(cap);
      return false;
    }
    this.log(`Ignoring stale cloud value for ${cap} (${incoming}), keeping ${pending.value}`);
    return true;
  }

  _sameValue(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.01;
    return a === b;
  }

  /**
   * Applique (une seule fois) les plages min/max reelles de l'appareil aux
   * capabilities de consigne, d'apres heatMin/heatMax remontes par l'API.
   */
  async _applyRanges(data) {
    if (this._rangesApplied) return;
    const jobs = [];
    if (data.tankHeatMin != null && data.tankHeatMax != null && this.hasCapability('target_temperature')) {
      jobs.push(this.setCapabilityOptions('target_temperature', {
        min: data.tankHeatMin, max: data.tankHeatMax, step: 1,
      }));
    }
    if (data.zoneHeatMin != null && data.zoneHeatMax != null && this.hasCapability('target_temperature.zone')) {
      const label = data.zoneIsCurveOffset
        ? { en: 'Zone curve offset', fr: "Decalage loi d'eau zone" }
        : { en: 'Zone water setpoint', fr: "Consigne d'eau zone" };
      jobs.push(this.setCapabilityOptions('target_temperature.zone', {
        title: label, min: data.zoneHeatMin, max: data.zoneHeatMax, step: 1,
      }));
    }
    if (jobs.length) {
      try { await Promise.all(jobs); this._rangesApplied = true; }
      catch (err) { this.error('applyRanges failed:', err.message); }
    }
  }

  // =========================================================================
  //  Ecoute des commandes
  // =========================================================================

  /**
   * Rafraichissement de courtoisie apres une commande, debounce : plusieurs
   * ordres rapproches ne declenchent qu'un seul appel au cloud.
   */
  _refreshSoon() {
    this._cancelRefresh();
    this._refreshTimer = this.homey.setTimeout(() => {
      this._refreshTimer = null;
      this._poll().catch(() => {});
    }, POST_COMMAND_REFRESH_MS);
  }

  async _onSetTankTemperature(value) {
    this.log(`Command: tank setpoint -> ${value}`);
    await this.client.setTankTemperature(this.deviceId, value);
    await this._commit('target_temperature', Math.round(Number(value)));
    this._refreshSoon();
  }

  async _onSetZoneTemperature(value) {
    this.log(`Command: zone setpoint/offset -> ${value} (zone ${this.zoneId})`);
    await this.client.setZoneTemperature(this.deviceId, value, this.zoneId);
    await this._commit('target_temperature.zone', Math.round(Number(value)));
    this._refreshSoon();
  }

  async _onCapabilityThermostatMode(value) {
    this.log(`Command: thermostat_mode -> ${value}`);
    await this.client.setMode(this.deviceId, value);
    await this._commit('thermostat_mode', value);

    // setMode() pilote aussi la zone et l'autorisation ECS : on aligne les
    // interrupteurs sur ce qui vient d'etre envoye (cf. AquareaClient.setMode).
    if (value !== 'off') {
      await this._commit('onoff.zone', true);
      if (value === 'heat_tank') await this._commit('onoff.tank', true);
      else if (value === 'heat') await this._commit('onoff.tank', false);
    }
    this._refreshSoon();
  }

  async _onSetTankOnoff(value) {
    this.log(`Command: tank on/off -> ${value}`);
    const on = Boolean(value);
    await this.client.setTankOperation(this.deviceId, on);
    await this._commit('onoff.tank', on);

    // En chauffage, l'autorisation ECS distingue 'heat' de 'heat_tank'.
    const mode = this.getCapabilityValue('thermostat_mode');
    if (mode === 'heat' || mode === 'heat_tank') {
      await this._commit('thermostat_mode', on ? 'heat_tank' : 'heat');
    }
    this._refreshSoon();
  }

  async _onSetZoneOnoff(value) {
    this.log(`Command: zone on/off -> ${value} (zone ${this.zoneId})`);
    const on = Boolean(value);
    await this.client.setZoneOperation(this.deviceId, on, this.zoneId);
    await this._commit('onoff.zone', on);
    this._refreshSoon();
  }

  // =========================================================================
  //  Cycle de vie
  // =========================================================================

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('poll_interval')) {
      this.log('Poll interval changed, restarting poller');
      this._startPolling();
    }
  }

  async onDeleted() {
    this.log(`Aquarea device deleted: ${this.deviceId}`);
    this._stopPolling();
    this._cancelRefresh();
  }

  async onUninit() {
    this._stopPolling();
    this._cancelRefresh();
  }

}

module.exports = AquareaDevice;
