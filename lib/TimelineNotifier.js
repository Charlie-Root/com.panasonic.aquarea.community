'use strict';

/**
 * Posts device state changes to the Homey timeline.
 *
 * Homey does not put capability changes on the timeline by itself: only
 * `homey.notifications.createNotification()` (or a user Flow with "Create
 * notification") does. This helper turns the changes a device reports into
 * short timeline entries.
 *
 * Changes that arrive close together — one poll typically flips power, mode
 * and zone at once — are collected for a short moment and posted as a single
 * entry, so the timeline is not flooded.
 *
 * The device setting `timeline_notifications` switches it off. A device paired
 * before the setting existed has no value for it (null), which counts as on.
 */

const FLUSH_DELAY_MS = 3000;

/** Capabilities that produce a timeline entry, and how to phrase them. */
const DESCRIBERS = {
  onoff: (t, value) => t(value ? 'timeline.power_on' : 'timeline.power_off'),
  'onoff.tank': (t, value) => t(value ? 'timeline.tank_on' : 'timeline.tank_off'),
  'onoff.zone': (t, value) => t(value ? 'timeline.zone_on' : 'timeline.zone_off'),
  defrost_active: (t, value) => t(value ? 'timeline.defrost_on' : 'timeline.defrost_off'),
  thermostat_mode: (t, value, previous) => {
    // Going to or from "off" is a power change, already reported by `onoff`.
    if (value === 'off' || previous === 'off') return null;
    return t('timeline.mode_changed', { mode: t(`timeline.mode.${value}`) });
  },
};

class TimelineNotifier {

  /**
   * @param {import('homey').Device} device
   */
  constructor(device) {
    this._device = device;
    this._pending = new Map(); // capability -> phrase (last change wins)
    this._timer = null;
  }

  /** true when the capability is one that gets a timeline entry. */
  static handles(capability) {
    return Object.prototype.hasOwnProperty.call(DESCRIBERS, capability);
  }

  get _enabled() {
    return this._device.getSetting('timeline_notifications') !== false;
  }

  /**
   * Records a real state change (caller guarantees value !== previous).
   */
  stateChanged(capability, value, previous) {
    if (!TimelineNotifier.handles(capability) || !this._enabled) return;

    const homey = this._device.homey;
    const t = (key, tokens) => homey.__(key, tokens);
    const phrase = DESCRIBERS[capability](t, value, previous);
    if (!phrase) return;

    // A change that is undone before the flush (off -> on within a few
    // seconds) simply replaces the earlier phrase.
    this._pending.delete(capability);
    this._pending.set(capability, phrase);

    if (!this._timer) {
      this._timer = homey.setTimeout(() => this.flush(), FLUSH_DELAY_MS);
    }
  }

  /** Posts the collected changes as one timeline entry. */
  async flush() {
    if (this._timer) {
      this._device.homey.clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._pending.size === 0) return;

    const changes = [...this._pending.values()].join(', ');
    this._pending.clear();

    const excerpt = this._device.homey.__('timeline.excerpt', {
      name: this._device.getName(),
      changes,
    });
    try {
      await this._device.homey.notifications.createNotification({ excerpt });
    } catch (err) {
      this._device.error('Timeline notification failed:', err.message);
    }
  }

  /** Drops anything pending; call on device unload / delete. */
  destroy() {
    if (this._timer) {
      this._device.homey.clearTimeout(this._timer);
      this._timer = null;
    }
    this._pending.clear();
  }

}

module.exports = TimelineNotifier;
