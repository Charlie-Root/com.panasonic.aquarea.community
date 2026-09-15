'use strict';

const Homey = require('homey');
const AquareaClient = require('../../lib/AquareaClient');

/**
 * Aquarea heat pump driver.
 *
 * Pairing uses the Homey `login_credentials` template: the user enters their
 * Aquarea Smart Cloud e-mail / password, the credentials are checked through
 * AquareaClient, then the devices linked to the account are listed.
 *
 * ⚠️  Recommended: use a DEDICATED ACCOUNT shared from the main account, to
 *     avoid session conflicts (Aquarea Smart Cloud only allows a single
 *     active session per account).
 */
class AquareaDriver extends Homey.Driver {

  async onInit() {
    this.log('AquareaDriver initialized');
  }

  onPair(session) {
    // Credentials entered during this pairing session + authenticated client.
    let credentials = { username: null, password: null };
    let client = null;

    // Step 1: validate the credentials (login_credentials template).
    session.setHandler('login', async data => {
      const username = (data.username || '').trim();
      const password = data.password || '';

      if (!username || !password) {
        throw new Error(this.homey.__('error.credentials_required'));
      }

      client = new AquareaClient({
        username,
        password,
        log: (...a) => this.log('[pair]', ...a),
        error: (...a) => this.error('[pair]', ...a),
      });

      // Actually test the credentials.
      try {
        await client.login();
      } catch (err) {
        this.error('Pairing login failed:', err.message);
        client = null;
        // Returning false => Homey shows "invalid credentials".
        return false;
      }

      credentials = { username, password };
      return true;
    });

    // Step 2: list the devices available to add.
    session.setHandler('list_devices', async () => {
      if (!credentials.username || !client) {
        throw new Error(this.homey.__('error.pair_session_invalid'));
      }

      const devices = await client.getDevices();

      if (!devices.length) {
        throw new Error(this.homey.__('error.no_devices_found'));
      }

      // Session (tokens + clientId + cookies) reusable by the device, to avoid
      // a full re-authentication on first start.
      const savedSession = client.exportSession();

      return devices.map(d => ({
        name: d.name,
        data: {
          id: d.id,
        },
        store: {
          // The e-mail/password pair stays required for this API (OAuth
          // re-authentication). Homey encrypts the store at rest.
          username: credentials.username,
          password: credentials.password,
          session: savedSession,
          deviceType: d.deviceType,
        },
        settings: {
          poll_interval: 300,
        },
      }));
    });
  }

  /**
   * Repair: hands the device a fresh password without losing it.
   *
   * A changed Panasonic password used to mean delete + re-pair, which takes
   * every Insights history and every Flow reference with it. Repair swaps the
   * credentials in the store of the existing device instead.
   */
  onRepair(session, device) {
    session.setHandler('login', async data => {
      const username = (data.username || '').trim();
      const password = data.password || '';

      if (!username || !password) {
        throw new Error(this.homey.__('error.credentials_required'));
      }

      const client = new AquareaClient({
        username,
        password,
        log: (...a) => this.log('[repair]', ...a),
        error: (...a) => this.error('[repair]', ...a),
      });

      // Never store credentials we have not seen work.
      try {
        await client.login();
      } catch (err) {
        this.error('Repair login failed:', err.message);
        throw new Error(this.homey.__('error.invalid_credentials'));
      }

      // ⚠️  Logging in successfully is not enough: the user may have typed the
      //     credentials of another Panasonic account, which authenticates fine
      //     and then cannot see this heat pump at all. Storing those would turn
      //     the tile into a permanently failing device.
      const deviceId = String(device.getData().id);
      const devices = await client.getDevices();
      if (!devices.some(d => String(d.id) === deviceId)) {
        throw new Error(this.homey.__('error.device_not_in_account'));
      }

      await device.setStoreValue('username', username);
      await device.setStoreValue('password', password);
      await device.setStoreValue('session', client.exportSession());

      // Let the device pick the new credentials up now: without this it would
      // keep using the client built at onInit() until the app restarts. The
      // store is already written, so a failure here is not a failed repair --
      // the next poll or restart recovers on its own.
      try {
        await device.onCredentialsRepaired();
      } catch (err) {
        this.error('Device restart after repair failed:', err.message);
      }

      return true;
    });
  }

}

module.exports = AquareaDriver;
