# Panasonic Aquarea (Community) — App Homey

> **⚠️ Application NON OFFICIELLE / UNOFFICIAL APP**
>
> Cette application est un projet **communautaire** et n'est **en aucune manière
> affiliée, approuvée, sponsorisée ou soutenue par Panasonic Corporation** ni par
> aucune de ses filiales. Les noms « Panasonic » et « Aquarea » sont des marques
> déposées de leurs propriétaires respectifs et ne sont utilisés ici qu'à des fins
> d'interopérabilité et de description.
>
> *This is a community project and is **not affiliated with, endorsed by, or
> supported by Panasonic Corporation** in any way. Use at your own risk.*

Pilotage des pompes à chaleur **air/eau Panasonic Aquarea** depuis Homey, via le
service web **Aquarea Smart Cloud** (`aquarea-smart.panasonic.com`).

---

## ⚠️ Avertissements importants

### 1. Utilisation aux risques de l'utilisateur

Cette application communique avec une **API web privée** non documentée, obtenue
par rétro-ingénierie du service *Aquarea Smart Cloud* (dans l'esprit de la
librairie Python [`aioaquarea`](https://github.com/cjaliaga/home-assistant-aioaquarea)).

Cette API **peut changer ou être coupée à tout moment sans préavis** par
Panasonic. L'application peut donc **cesser de fonctionner du jour au lendemain**.
Vous utilisez ce logiciel **entièrement à vos propres risques**. Les auteurs
déclinent toute responsabilité en cas de dysfonctionnement, de perte de données,
de blocage de compte, ou de dommage matériel sur votre installation.

> ℹ️ **Ne pas confondre avec « Panasonic Comfort Cloud »**, qui pilote les
> climatiseurs *air/air*. Cette application cible uniquement les PAC *air/eau*
> **Aquarea** exposées via *Aquarea Smart Cloud*.

### 2. Utilisez un SECOND compte Panasonic dédié à Homey

**Recommandation forte :** créez un **compte Panasonic secondaire dédié à Homey**,
puis **partagez votre installation Aquarea depuis votre compte principal** vers ce
compte secondaire.

Pourquoi ?

- Aquarea Smart Cloud n'autorise en pratique **qu'une seule session active** par
  compte. Si Homey se connecte avec le **même** compte que l'application mobile,
  chaque connexion **invalide la session de l'autre** : vous serez déconnecté en
  boucle de l'app mobile, et Homey devra se reconnecter sans arrêt.
- Multiplier les reconnexions augmente fortement le risque de
  **blocage / verrouillage temporaire du compte** par Panasonic.

Un compte dédié à Homey évite ces conflits de session et isole les éventuels
blocages du compte que vous utilisez au quotidien.

### 3. Rate-limiting / limitation de débit

L'API Aquarea Smart Cloud applique une **limitation de débit** (*rate-limiting*).
Un nombre trop élevé de requêtes sur une courte période peut entraîner :

- des erreurs temporaires (HTTP 429 / 403),
- un **bannissement temporaire de votre adresse IP**,
- un **verrouillage temporaire du compte**.

Pour cette raison :

- L'intervalle de **polling par défaut est volontairement élevé : 300 secondes
  (5 minutes)**.
- **Ne réduisez pas cet intervalle** sans nécessité. Un intervalle trop court est
  la cause la plus fréquente de blocage.
- Évitez d'enchaîner de nombreuses commandes (consigne, mode) en très peu de temps.

---

## Fonctionnalités

- Découverte automatique des PAC Aquarea rattachées au compte.
- Remontée de la **température d'eau/zone**, de la **consigne**, de la
  **température extérieure** et du **mode de fonctionnement**.
- Commandes : **consigne d'eau** (`target_temperature`) et **mode**
  (`thermostat_mode` : Auto / Heat / Cool / Off).
- Moteur de **polling sécurisé** (5 min par défaut).
- **Re-login automatique** en cas d'expiration de session (HTTP 401/403).

## Capabilities exposées

| Capability                      | Description                                   | Sens |
| ------------------------------- | --------------------------------------------- | ---- |
| `onoff.tank`                    | Marche/arrêt du ballon ECS                    | contrôle |
| `onoff.zone`                    | Marche/arrêt de la zone de chauffage          | contrôle |
| `measure_temperature`           | Température du ballon ECS                      | lecture |
| `target_temperature`            | Consigne du ballon ECS (plage réelle de l'appareil, ~40–65 °C) | contrôle |
| `measure_temperature.zone`      | Température de la zone / du chauffage          | lecture |
| `target_temperature.zone`       | Consigne zone **ou** décalage de loi d'eau (−5…+5 °C) | contrôle |
| `thermostat_mode`               | Mode (auto / heat / cool / off)               | contrôle |
| `measure_temperature.outdoor`   | Température extérieure                         | lecture |

> ℹ️ **Consigne de zone.** Si votre zone est configurée en **loi d'eau**
> (courbe de chauffe), `target_temperature.zone` est un **décalage −5…+5 °C** ;
> si elle est en **température d'eau fixe**, c'est une température absolue. Les
> bornes min/max sont ajustées automatiquement d'après ce que renvoie votre
> installation.

## Installation & appairage

1. Installez l'application sur votre Homey.
2. Ajoutez un appareil → *Panasonic Aquarea (Community)*.
3. Saisissez l'**e-mail** et le **mot de passe** du **compte dédié** Aquarea
   Smart Cloud (voir §2).
4. L'application teste les identifiants, liste vos PAC et vous laisse les ajouter.

## Dépendances

- `node-fetch` (client HTTP)

```bash
npm install
```

## Avertissement final

Ce dépôt est fourni « **tel quel** », sans aucune garantie. Il ne s'agit **pas**
d'un produit Panasonic. En l'installant, vous acceptez d'en assumer l'entière
responsabilité.
