Panasonic Aquarea (Community) — Homey App

UNOFFICIAL APP

This is a community project and is not affiliated with, endorsed by, or supported by Panasonic Corporation in any way. The names "Panasonic" and "Aquarea" are registered trademarks of their respective owners and are used here solely for interoperability and descriptive purposes.

Use at your own risk.

Control your Panasonic Aquarea air/water and water/water heat pumps from Homey, via the Aquarea Smart Cloud web service (aquarea-smart.panasonic.com).


IMPORTANT WARNINGS

1. Use at your own risk

This application communicates with an undocumented private web API, obtained by reverse-engineering the Aquarea Smart Cloud service.

This API may change or be shut down at any time without notice by Panasonic. The application may therefore stop working overnight. You use this software entirely at your own risk. The authors disclaim all liability for malfunctions, data loss, account lockouts, or damage to your installation.

Do not confuse with "Panasonic Comfort Cloud", which controls air/air heat pumps. This application targets only Aquarea air/water heat pumps exposed via Aquarea Smart Cloud.

2. Use a DEDICATED second Panasonic account for Homey

Strong recommendation: create a dedicated secondary Panasonic account for Homey, then share your Aquarea installation from your main account to this secondary account.

Why?

Aquarea Smart Cloud only allows one active session per account in practice. If Homey connects with the same account as the mobile app, each connection invalidates the other's session: you will be repeatedly logged out of the mobile app, and Homey will have to reconnect constantly.

Repeated reconnections significantly increase the risk of account blocking / temporary lockout by Panasonic.

A dedicated Homey account avoids these session conflicts and isolates any potential lockouts from the account you use daily.

3. Rate-limiting

The Aquarea Smart Cloud API enforces rate-limiting. Too many requests in a short period may result in temporary errors (HTTP 429 / 403), a temporary ban of your IP address, or a temporary account lockout.

For this reason:

- The default polling interval is intentionally high: 300 seconds (5 minutes).
- Do not reduce this interval unnecessarily. Too short an interval is the most common cause of blocking.
- Avoid sending many commands (setpoint, mode) in rapid succession.


FEATURES

- Automatic discovery of Aquarea heat pumps linked to the account.
- Reporting of water/zone temperature, setpoint, outdoor temperature and operating mode.
- Commands: water setpoint (target_temperature) and mode (thermostat_mode: Auto / Heat / Cool / Off).
- Secure polling engine (5 min by default).
- Automatic re-login on session expiry (HTTP 401/403).


EXPOSED CAPABILITIES

- onoff.tank : Domestic hot water tank on/off (control)
- onoff.zone : Heating zone on/off (control)
- measure_temperature : DHW tank temperature (read)
- target_temperature : DHW tank setpoint, range ~40-65 °C (control)
- measure_temperature.zone : Zone / heating temperature (read)
- target_temperature.zone : Zone setpoint or heating curve offset (-5...+5 °C) (control)
- thermostat_mode : Mode (auto / heat / cool / off) (control)
- measure_temperature.outdoor : Outdoor temperature (read)

Note on zone setpoint: if your zone is configured with a heating curve (weather compensation), target_temperature.zone is an offset of -5...+5 °C; if it uses a fixed water temperature, it is an absolute temperature. The min/max limits are automatically adjusted based on what your installation reports.


INSTALLATION & PAIRING

1. Install the application on your Homey.
2. Add a device > Panasonic Aquarea (Community).
3. Enter the email and password of the dedicated Aquarea Smart Cloud account (see section 2).
4. The application tests the credentials, lists your heat pumps and lets you add them.


FINAL DISCLAIMER

This repository is provided "as is", without any warranty. It is not a Panasonic product. By installing it, you agree to take full responsibility for its use.
