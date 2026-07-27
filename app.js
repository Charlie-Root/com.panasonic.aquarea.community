'use strict';

const Homey = require('homey');

/**
 * Panasonic Aquarea (Community) - point d'entree de l'application Homey.
 *
 * ⚠️  Application NON OFFICIELLE, sans lien avec Panasonic Corporation.
 *     Elle s'appuie sur une API privee (Aquarea Smart Cloud) obtenue par
 *     retro-ingenierie et peut cesser de fonctionner a tout moment.
 */
class AquareaApp extends Homey.App {

  async onInit() {
    this.log('====================================================');
    this.log(' Panasonic Aquarea (Community) - starting');
    this.log(' UNOFFICIAL app. Not affiliated with Panasonic Corp.');
    this.log(' Uses a private, undocumented cloud API. Use at your own risk.');
    this.log(' Please respect the polling interval to avoid rate-limiting.');
    this.log('====================================================');

    // Journalisation globale des rejets non captures, pour faciliter le debug.
    process.on('unhandledRejection', reason => {
      this.error('Unhandled promise rejection:', reason);
    });
  }

  async onUninit() {
    this.log('Panasonic Aquarea (Community) - stopping');
  }

}

module.exports = AquareaApp;
