'use strict';

const Homey = require('homey');
const AquareaHomeClient = require('../../lib/AquareaHomeClient');

// Default polling interval: 60 seconds.
const DEFAULT_POLL_INTERVAL = 60;
const MIN_POLL_INTERVAL     = 30;

// Consecutive failed polls tolerated before the device is marked unavailable.
// A single timeout or a dropped HTTP/2 connection is routine; three in a row
// means the convector really is out of reach.
const MAX_POLL_FAILURES = 3;

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
    this._pollFailures = 0;

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

    // ⚠️  A failing login must not abort onInit: Homey would then leave the
    //     device without a single capability listener, and every tile press
    //     would fail for as long as the app runs. Report the problem and carry
    //     on — the poller recovers on its own once the API answers again.
    try {
      await this._initClient();
    } catch (err) {
      this.error('Client init failed:', err.message);
      await this.setUnavailable(this.homey.__('error.connection_failed', { message: err.message }))
        .catch(() => {});
    }

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

  /**
   * Called by the driver once a repair has written verified credentials and a
   * fresh session to the store. Rebuilds the client around them and polls at
   * once — for a convector paired before the credentials were persisted this
   * is the moment it stops being a dead tile, so it must not wait for the next
   * app restart.
   */
  async onCredentialsRepaired() {
    this.log('Credentials repaired: reconnecting with the new session');
    this._stopPolling();

    await this._initClient();

    // The failure budget belongs to the old credentials: a device parked at
    // MAX_POLL_FAILURES by a terminal auth error would otherwise stay
    // unavailable even though the very next poll succeeds.
    this._pollFailures = 0;

    // ⚠️  _poll() is the only thing allowed to decide availability here: it
    //     calls setAvailable() when the call goes through and setUnavailable()
    //     when the credentials are still refused. Flipping the device back to
    //     available from here would paper over a repair on the wrong account.
    await this._poll();

    this._startPolling();
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

      // The call itself went through — which may have taken a transparent
      // re-login — so the convector is reachable whatever the payload holds.
      await this._persistSession();
      this._pollFailures = 0;
      if (!this.getAvailable()) await this.setAvailable();

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
    } catch (err) {
      this.error('Poll error:', err.message);

      // An authentication failure is terminal: the stored credentials are
      // missing or refused, and polling again will not change that. Say so
      // straight away instead of leaving the device silently stale.
      if (AquareaHomeClient.isAuthFailure(err)) {
        this._pollFailures = MAX_POLL_FAILURES;
        this.setUnavailable(this.homey.__('error.missing_credentials')).catch(() => {});
        return;
      }

      // Anything else is treated as a blip until it has happened often enough
      // to be real: the convector used to drop out of Homey — breaking Flows
      // and greying out its tiles — on a single network timeout.
      this._pollFailures += 1;
      if (this._pollFailures >= MAX_POLL_FAILURES) {
        this.setUnavailable(this.homey.__('error.connection_failed', { message: err.message }))
          .catch(() => {});
      }
    }
  }

  // ─── Capability listeners ──────────────────────────────────────────────────

  _registerCapabilityListeners() {
    const mac = this._getMacAddress();

    // The listeners are registered even when the initial login failed, so a
    // tile press must surface a readable error instead of "cannot read
    // setPower of null".
    const client = () => {
      if (!this._client) throw new Error(this.homey.__('error.missing_credentials'));
      return this._client;
    };

    this.registerCapabilityListener('onoff', async value => {
      await client().setPower(mac, value);
    });

    this.registerCapabilityListener('target_temperature', async value => {
      await client().setTemperature(mac, value);
    });

    this.registerCapabilityListener('thermostat_mode', async value => {
      await client().setOperationMode(mac, value);
    });

    this.registerCapabilityListener('convector_fan_speed', async value => {
      await client().setFanSpeed(mac, value);
    });

    this.registerCapabilityListener('convector_flap', async value => {
      await client().setFlap(mac, value);
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

  // Without this the interval survives an app restart or a device reload and
  // keeps polling on behalf of a device instance that no longer exists.
  async onUninit() {
    this._stopPolling();
  }

}

module.exports = AquareaConvectorDevice;
