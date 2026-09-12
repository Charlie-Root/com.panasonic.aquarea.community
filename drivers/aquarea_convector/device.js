'use strict';

const Homey = require('homey');
const AquareaHomeClient = require('../../lib/AquareaHomeClient');

// Default polling interval: 60 seconds.
const DEFAULT_POLL_INTERVAL = 60;
const MIN_POLL_INTERVAL     = 30;

// Mapping operationMode int -> thermostat_mode string
const MODE_INT_TO_STR = { 0: 'auto', 1: 'heat', 2: 'cool' };
const MODE_STR_TO_INT = { auto: 0, heat: 1, cool: 2 };

const FAN_INT_TO_STR = { 0: 'auto', 1: 'night', 2: 'max' };

/**
 * Homey device for an Aquarea Home convector / fan coil.
 *
 * Capabilities:
 *   - onoff                  (power on / off)
 *   - target_temperature     (temperature setpoint, 5-40 °C)
 *   - measure_temperature    (measured room temperature)
 *   - thermostat_mode        (auto / heat / cool)
 *   - convector_fan_speed    (auto / night / max)
 *   - convector_flap         (flap open/closed)
 */
class AquareaConvectorDevice extends Homey.Device {

  async onInit() {
    this.log('AquareaConvectorDevice init:', this.getName());

    this._client = null;
    this._pollTimer = null;

    // Removes the old experimental alarm capabilities from already installed
    // devices, without recreating the device or affecting its Flows.
    for (const capability of ['alarm_generic', 'convector_alarm_codes']) {
      if (this.hasCapability(capability)) {
        try {
          await this.removeCapability(capability);
        } catch (err) {
          // A custom capability removed from the manifest may still be present
          // on an older device. Homey then answers 404 to its removal; that
          // must not prevent the device from starting.
          this.error(`Unable to remove legacy capability ${capability}: ${err.message}`);
        }
      }
    }

    await this._initClient();
    this._registerCapabilityListeners();
    await this._poll();
    this._startPolling();
  }

  // ─── Client ────────────────────────────────────────────────────────────────

  async _initClient() {
    const store = this.getStore();
    this._client = new AquareaHomeClient({
      email:    store.email,
      password: store.password,
      log:      (...a) => this.log(...a),
      error:    (...a) => this.error(...a),
    });

    if (store.session) {
      this._client.importSession(store.session);
    }

    // ⚠️  Devices paired before the credentials were persisted only have a
    //     stored JWT. They keep working for as long as that token is accepted,
    //     but nothing can revive them once it expires — so only complain when
    //     there is no session left to try. The poller flags the moment the
    //     token is actually refused (see _poll).
    if (!store.email || !store.password) {
      this.log('No stored credentials: re-authentication is impossible, re-pair the device');
      if (!store.session) {
        await this.setUnavailable(this.homey.__('error.missing_credentials'));
      }
      return;
    }

    if (!store.session) {
      await this._client.login();
    }
  }

  /**
   * Persists the session after a re-login, so a Homey restart does not start
   * from a token that is already known to be dead. Only written when the token
   * actually changed: the store lives on flash.
   */
  async _persistSession() {
    const session = this._client.exportSession();
    if (!session || !session.token) return;
    if (session.token === (this.getStoreValue('session') || {}).token) return;

    await this.setStoreValue('session', session).catch(err => {
      this.error('Unable to persist session:', err.message);
    });
  }

  _getMacAddress() {
    return this.getStore().macAddress || this.getData().id;
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  _startPolling() {
    this._stopPolling();
    const interval = Math.max(
      MIN_POLL_INTERVAL,
      (this.getSetting('poll_interval') || DEFAULT_POLL_INTERVAL)
    ) * 1000;

    this._pollTimer = this.homey.setInterval(() => this._poll(), interval);
  }

  _stopPolling() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _poll() {
    try {
      const mac    = this._getMacAddress();
      const status = await this._client.getDeviceStatus(mac);

      if (!status || Object.keys(status).length === 0) return;

      // onoff
      if (status.powerState !== undefined) {
        await this.setCapabilityValue('onoff', !!status.powerState).catch(() => {});
      }

      // measure_temperature (room temperature)
      if (status.roomTemperature !== null && status.roomTemperature !== undefined) {
        await this.setCapabilityValue('measure_temperature', status.roomTemperature).catch(() => {});
      }

      // target_temperature (setpoint) - refresh the dynamic bounds if available
      if (status.setpointMin !== null && status.setpointMin !== undefined &&
          status.setpointMax !== null && status.setpointMax !== undefined) {
        const opts = { min: status.setpointMin, max: status.setpointMax };
        if (status.setpointStep !== null && status.setpointStep !== undefined) {
          opts.step = status.setpointStep;
        }
        await this.setCapabilityOptions('target_temperature', opts).catch(() => {});
      }
      if (status.setpoint !== null && status.setpoint !== undefined) {
        await this.setCapabilityValue('target_temperature', status.setpoint).catch(() => {});
      }

      // thermostat_mode
      if (status.operationMode !== null && status.operationMode !== undefined) {
        const modeStr = MODE_INT_TO_STR[status.operationMode] || 'auto';
        await this.setCapabilityValue('thermostat_mode', modeStr).catch(() => {});
      }

      // convector_fan_speed
      if (status.fanSpeed !== null && status.fanSpeed !== undefined) {
        const speedStr = FAN_INT_TO_STR[status.fanSpeed] || 'auto';
        await this.setCapabilityValue('convector_fan_speed', speedStr).catch(() => {});
      }

      // convector_flap
      if (status.flap !== null && status.flap !== undefined) {
        await this.setCapabilityValue('convector_flap', !!status.flap).catch(() => {});
      }

      // The poll may have gone through a transparent re-login.
      await this._persistSession();

      this.setAvailable();
    } catch (err) {
      this.error('Poll error:', err.message);

      // An authentication failure is terminal: the stored credentials are
      // missing or refused, and polling again will not change that. Say so
      // straight away instead of leaving the device silently stale.
      if (AquareaHomeClient.isAuthFailure(err)) {
        this.setUnavailable(this.homey.__('error.missing_credentials')).catch(() => {});
        return;
      }

      this.setUnavailable(err.message).catch(() => {});
    }
  }

  // ─── Capability listeners ──────────────────────────────────────────────────

  _registerCapabilityListeners() {
    const mac = this._getMacAddress();

    this.registerCapabilityListener('onoff', async value => {
      await this._client.setPower(mac, value);
    });

    this.registerCapabilityListener('target_temperature', async value => {
      await this._client.setTemperature(mac, value);
    });

    this.registerCapabilityListener('thermostat_mode', async value => {
      await this._client.setOperationMode(mac, value);
    });

    this.registerCapabilityListener('convector_fan_speed', async value => {
      await this._client.setFanSpeed(mac, value);
    });

    this.registerCapabilityListener('convector_flap', async value => {
      await this._client.setFlap(mac, value);
    });
  }

  // ─── Settings ──────────────────────────────────────────────────────────────

  async onSettings({ newSettings }) {
    this._startPolling();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async onDeleted() {
    this._stopPolling();
    this.log('AquareaConvectorDevice deleted:', this.getName());
  }

}

module.exports = AquareaConvectorDevice;
