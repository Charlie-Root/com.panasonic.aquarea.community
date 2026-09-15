'use strict';

const Homey = require('homey');
const AquareaHomeClient = require('../../lib/AquareaHomeClient');

/**
 * Driver for Aquarea Home convectors / fan coils (Solution Tech Srl).
 *
 * Pairing uses the Homey `login_credentials` template: the user enters their
 * Aquarea Home e-mail / password, the credentials are checked through
 * AquareaHomeClient, then the available devices are listed.
 */
class AquareaConvectorDriver extends Homey.Driver {

  async onInit() {
    this.log('AquareaConvectorDriver initialized');
  }

  onPair(session) {
    // Credentials entered during this pairing session + authenticated client.
    let credentials = { email: null, password: null };
    let client = null;

    session.setHandler('login', async data => {
      const email    = (data.username || '').trim();
      const password = data.password || '';

      if (!email || !password) {
        throw new Error(this.homey.__('error.credentials_required'));
      }

      client = new AquareaHomeClient({
        email,
        password,
        log:   (...a) => this.log('[pair]', ...a),
        error: (...a) => this.error('[pair]', ...a),
      });

      try {
        await client.login();
      } catch (err) {
        this.error('Pairing login failed:', err.message);
        client = null;
        return false;
      }

      credentials = { email, password };
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!credentials.email || !client) {
        throw new Error(this.homey.__('error.pair_session_invalid'));
      }

      const devices = await client.getDevices();

      if (!devices.length) {
        throw new Error(this.homey.__('error.no_convectors_found'));
      }

      const savedSession = client.exportSession();

      return devices.map(d => ({
        name: d.name,
        data: {
          id: d.macAddress,
        },
        store: {
          macAddress: d.macAddress,
          // The e-mail/password pair must be kept: the JWT expires and the
          // only way back is a fresh login. Homey encrypts the store at rest.
          email:      credentials.email,
          password:   credentials.password,
          session:    savedSession,
        },
        settings: {
          poll_interval: 60,
        },
      }));
    });
  }

  /**
   * Repair: gives an existing convector fresh credentials.
   *
   * Besides the changed-password case, this is the migration path for the
   * convectors paired before the credentials were persisted in the store:
   * those hold nothing but a JWT and can never log in again on their own.
   * Repairing them beats delete + re-pair, which loses all Insights history.
   */
  onRepair(session, device) {
    session.setHandler('login', async data => {
      const email    = (data.username || '').trim();
      const password = data.password || '';

      if (!email || !password) {
        throw new Error(this.homey.__('error.credentials_required'));
      }

      const client = new AquareaHomeClient({
        email,
        password,
        log:   (...a) => this.log('[repair]', ...a),
        error: (...a) => this.error('[repair]', ...a),
      });

      // Never store credentials we have not seen work.
      try {
        await client.login();
      } catch (err) {
        this.error('Repair login failed:', err.message);
        throw new Error(this.homey.__('error.invalid_credentials'));
      }

      // ⚠️  A successful login proves the account exists, not that it owns
      //     THIS convector. Credentials from another Aquarea Home account
      //     would authenticate and then never see the device again.
      const mac = String(device.getStore().macAddress || device.getData().id || '').trim().toLowerCase();
      const devices = await client.getDevices();
      if (!devices.some(d => String(d.macAddress || '').trim().toLowerCase() === mac)) {
        throw new Error(this.homey.__('error.device_not_in_account'));
      }

      await device.setStoreValue('email', email);
      await device.setStoreValue('password', password);
      await device.setStoreValue('session', client.exportSession());

      // Reconnect right away rather than at the next app restart. The store is
      // already written, so a failure here is not a failed repair: the poller
      // picks the new credentials up on its own from the next restart.
      try {
        await device.onCredentialsRepaired();
      } catch (err) {
        this.error('Device reconnect after repair failed:', err.message);
      }

      return true;
    });
  }

}

module.exports = AquareaConvectorDriver;
