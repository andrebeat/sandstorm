// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const ADMIN_TOKEN_EXPIRATION_TIME = 15 * 60 * 1000;
const publicAdminSettings = [
  "google", "github", "ldap", "saml", "emailToken", "splashUrl", "signupDialog",
  "adminAlert", "adminAlertTime", "adminAlertUrl", "termsUrl",
  "privacyUrl", "appMarketUrl", "appIndexUrl", "appUpdatesEnabled",
  "serverTitle", "returnAddress", "ldapNameField", "organizationMembership",
  "organizationSettings",
];

const FEATURE_KEY_FIELDS_PUBLISHED_TO_ADMINS = [
  "customer", "expires", "features", "isElasticBilling", "isTrial", "issued", "userLimit",
];

const PUBLIC_FEATURE_KEY_FIELDS = [
  "expires", "features",
];

const Fs = Npm.require("fs");
const Crypto = Npm.require("crypto");
const SANDSTORM_ADMIN_TOKEN = SANDSTORM_VARDIR + "/adminToken";

const tokenIsValid = function (token) {
  if (token && Fs.existsSync(SANDSTORM_ADMIN_TOKEN)) {
    const stats = Fs.statSync(SANDSTORM_ADMIN_TOKEN);
    const expireTime = new Date(Date.now() - ADMIN_TOKEN_EXPIRATION_TIME);
    if (stats.mtime < expireTime) {
      return false;
    } else {
      return Fs.readFileSync(SANDSTORM_ADMIN_TOKEN, { encoding: "utf8" }) === token;
    }
  } else {
    return false;
  }
};

const tokenIsSetupSession = function (token) {
  if (token) {
    const setupSession = globalDb.collections.setupSession.findOne({ _id: "current-session" });
    if (setupSession) {
      const hash = Crypto.createHash("sha256").update(token).digest("base64");
      const now = new Date();
      const sessionLifetime = 24 * 60 * 60 * 1000; // length of setup session validity, in milliseconds: 1 day
      if (setupSession.hashedSessionId === hash && ((now - setupSession.creationDate) < sessionLifetime)) {
        return true;
      }
    }
  }

  return false;
};

// Export for use in other admin/ routes
checkAuth = function (token) {
  check(token, Match.OneOf(undefined, null, String));
  if (!isAdmin() && !tokenIsValid(token) && !tokenIsSetupSession(token)) {
    throw new Meteor.Error(403, "User must be admin or provide a valid token");
  }
};

const clearAdminToken = function (token) {
  if (tokenIsSetupSession(token)) {
    const hash = Crypto.createHash("sha256").update(token).digest("base64");
    globalDb.collections.setupSession.remove({
      _id: "current-session",
      hashedSessionId: hash,
    });
  }

  if (tokenIsValid(token)) {
    Fs.unlinkSync(SANDSTORM_ADMIN_TOKEN);
    console.log("Admin token deleted.");
  }
};

const smtpConfigShape = {
  hostname: String,
  port: Number,
  auth: {
    user: String,
    pass: String,
  },
  returnAddress: String,
};

Meteor.methods({
  setAccountSetting: function (token, serviceName, value) {
    checkAuth(token);
    check(serviceName, String);
    check(value, Boolean);

    // TODO(someday): currently this relies on the fact that an account is tied to a single
    // identity, and thus has only that entry in "services". This will need to be looked at when
    // multiple login methods/identities are allowed for a single account.
    if (!value && !tokenIsValid(token) && !tokenIsSetupSession(token) && (serviceName in Meteor.user().services)) {
      throw new Meteor.Error(403,
        "You can not disable the login service that your account uses.");
    }

    // Only check configurations for OAuth services.
    const oauthServices = ["google", "github"];
    if (value && (oauthServices.indexOf(serviceName) != -1)) {
      const ServiceConfiguration = Package["service-configuration"].ServiceConfiguration;
      const config = ServiceConfiguration.configurations.findOne({ service: serviceName });
      if (!config) {
        throw new Meteor.Error(403, "You must configure the " + serviceName +
          " service before you can enable it. Click the \"configure\" link.");
      }

      if (!config.clientId || !config.secret) {
        throw new Meteor.Error(403, "You must provide a non-empty clientId and secret for the " +
          serviceName + " service before you can enable it. Click the \"configure\" link.");
      }
    }

    Settings.upsert({ _id: serviceName }, { $set: { value: value } });
    if (value) {
      Settings.update({ _id: serviceName }, { $unset: { automaticallyReset: 1 } });
    }
  },

  setSmtpConfig: function (token, config) {
    checkAuth(token);
    check(config, smtpConfigShape);

    Settings.upsert({ _id: "smtpConfig" }, { $set: { value: config } });
  },

  setSetting: function (token, name, value) {
    checkAuth(token);
    check(name, String);
    check(value, Match.OneOf(null, String, Date, Boolean));

    Settings.upsert({ _id: name }, { $set: { value: value } });
  },

  submitFeatureKey: function (token, textBlock) {
    checkAuth(token);
    check(textBlock, Match.OneOf(null, String));

    const db = this.connection.sandstormDb;

    if (!textBlock) {
      // Delete the feature key.
      db.collections.featureKey.remove("currentFeatureKey");
      return;
    }

    // textBlock is a base64'd string, possibly with newlines and comment lines starting with "-"
    const featureKeyBase64 = _.chain(textBlock.split("\n"))
        .filter(line => (line.length > 0 && line[0] !== "-"))
        .value()
        .join("");

    const buf = new Buffer(featureKeyBase64, "base64");
    if (buf.length < 64) {
      throw new Meteor.Error(401, "Invalid feature key");
    }

    // loadSignedFeatureKey is provided in feature-key.js
    const featureKey = loadSignedFeatureKey(buf);
    if (!featureKey) {
      throw new Meteor.Error(401, "Invalid feature key");
    }

    // Persist the feature key in the database.
    db.collections.featureKey.upsert(
      "currentFeatureKey",
      {
        _id: "currentFeatureKey",
        value: buf,
      }
    );
  },

  saveOrganizationSettings(token, params) {
    checkAuth(token);
    check(params, {
      membership: {
        emailToken: {
          enabled: Boolean,
          domain: String,
        },
        google: {
          enabled: Boolean,
          domain: String,
        },
        ldap: {
          enabled: Boolean,
        },
        saml: {
          enabled: Boolean,
        },
      },
      settings: {
        disallowGuests: Boolean,
        shareContacts: Boolean,
      },
    });

    this.connection.sandstormDb.collections.settings.upsert({ _id: "organizationMembership" }, { value: params.membership });
    this.connection.sandstormDb.collections.settings.upsert({ _id: "organizationSettings" }, { value: params.settings });
  },

  adminConfigureLoginService: function (token, options) {
    checkAuth(token);
    check(options, Match.ObjectIncluding({ service: String }));

    const ServiceConfiguration = Package["service-configuration"].ServiceConfiguration;

    ServiceConfiguration.configurations.upsert({ service: options.service }, options);
  },

  clearResumeTokensForService: function (token, serviceName) {
    checkAuth(token);
    check(serviceName, String);

    const query = {};
    query["services." + serviceName] = { $exists: true };
    Meteor.users.find(query).forEach(function (identity) {
      if (identity.services.resume && identity.services.resume.loginTokens &&
          identity.services.resume.loginTokens.length > 0) {
        Meteor.users.update({ _id: identity._id }, { $set: { "services.resume.loginTokens": [] } });
      }

      Meteor.users.update({ "loginIdentities.id": identity._id },
                          { $set: { "services.resume.loginTokens": [] } });
    });
  },

  adminUpdateUser: function (token, userInfo) {
    checkAuth(token);
    check(userInfo, {
      userId: String,
      signupKey: Boolean,
      isAdmin: Boolean,
    });

    const userId = userInfo.userId;
    if (userId === Meteor.userId() && !userInfo.isAdmin) {
      throw new Meteor.Error(403, "User cannot remove admin permissions from itself.");
    }

    Meteor.users.update({ _id: userId }, { $set: _.omit(userInfo, ["_id", "userId"]) });
  },

  testSend: function (token, smtpConfig, to) {
    checkAuth(token);
    check(smtpConfig, smtpConfigShape);
    check(to, String);
    const { returnAddress, ...restConfig } = smtpConfig;

    SandstormEmail.send({
      to: to,
      from: globalDb.getServerTitle() + " <" + returnAddress + ">",
      subject: "Testing your Sandstorm's SMTP setting",
      text: "Success! Your outgoing SMTP is working.",
      smtpConfig: restConfig,
    });
  },

  createSignupKey: function (token, note, quota) {
    checkAuth(token);
    check(note, String);
    check(quota, Match.OneOf(undefined, null, Number));

    const key = Random.id();
    const content = { _id: key, used: false, note: note };
    if (typeof quota === "number") content.quota = quota;
    SignupKeys.insert(content);
    return key;
  },

  sendInvites: function (token, origin, from, list, subject, message, quota) {
    checkAuth(token);
    check([origin, from, list, subject, message], [String]);
    check(quota, Match.OneOf(undefined, null, Number));

    if (!from.trim()) {
      throw new Meteor.Error(403, "Must enter 'from' address.");
    }

    if (!list.trim()) {
      throw new Meteor.Error(403, "Must enter 'to' addresses.");
    }

    this.unblock();

    list = list.split("\n");
    for (const i in list) {
      const email = list[i].trim();

      if (email) {
        const key = Random.id();

        const content = {
          _id: key,
          used: false,
          note: "E-mail invite to " + email,
          email: email,
          definitelySent: false,
        };
        if (typeof quota === "number") content.quota = quota;
        SignupKeys.insert(content);
        SandstormEmail.send({
          to: email,
          from: from,
          envelopeFrom: globalDb.getReturnAddress(),
          subject: subject,
          text: message.replace(/\$KEY/g, origin + "/signup/" + key),
        });
        SignupKeys.update(key, { $set: { definitelySent: true } });
      }
    }

    return { sent: true };
  },

  offerIpNetwork: function (token) {
    checkAuth(token);
    if (!isAdmin()) {
      throw new Meteor.Error(403, "Offering IpNetwork is only allowed for logged in users " +
        "(a token is not sufficient). Please sign in with an admin account");
    }

    const requirements = [
      { userIsAdmin: Meteor.userId() },
    ];
    const sturdyRef = waitPromise(
      saveFrontendRef({ ipNetwork: true }, { webkey: null }, requirements)
    ).sturdyRef;
    return ROOT_URL.protocol + "//" + globalDb.makeApiHost(sturdyRef) + "#" + sturdyRef;
  },

  offerIpInterface: function (token) {
    checkAuth(token);
    if (!isAdmin()) {
      throw new Meteor.Error(403, "Offering IpInterface is only allowed for logged in users " +
        "(a token is not sufficient). Please sign in with an admin account");
    }

    const requirements = [
      { userIsAdmin: Meteor.userId() },
    ];
    const sturdyRef = waitPromise(
      saveFrontendRef({ ipInterface: true }, { webkey: null }, requirements)
    ).sturdyRef;
    return ROOT_URL.protocol + "//" + globalDb.makeApiHost(sturdyRef) + "#" + sturdyRef;
  },

  adminToggleDisableCap: function (token, capId, value) {
    checkAuth(token);
    check(capId, String);
    check(value, Boolean);

    if (value) {
      ApiTokens.update({ _id: capId }, { $set: { revoked: true } });
    } else {
      ApiTokens.update({ _id: capId }, { $set: { revoked: false } });
    }
  },

  updateQuotas: function (token, list, quota) {
    checkAuth(token);
    check(list, String);
    check(quota, Match.OneOf(undefined, null, Number));

    if (!list.trim()) {
      throw new Meteor.Error(400, "Must enter addresses.");
    }

    const items = list.split("\n");
    const invalid = [];
    for (const i in items) {
      const modifier = (typeof quota === "number") ? { $set: { quota: quota } }
                                                 : { $unset: { quota: "" } };
      let n = SignupKeys.update({ email: items[i] }, modifier, { multi: true });
      n += Meteor.users.update({ signupEmail: items[i] }, modifier, { multi: true });

      if (n < 1) invalid.push(items[i]);
    }

    if (invalid.length > 0) {
      throw new Meteor.Error(404, "These addresses did not map to any user nor invite: " +
          invalid.join(", "));
    }
  },

  dismissAdminStatsNotifications: function (token) {
    checkAuth(token);
    globalDb.collections.notifications.remove({ "admin.type": "reportStats" });
  },

  signUpAsAdmin: function (token) {
    check(token, String);
    checkAuth(token);
    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in to sign up as admin.");
    }

    if (!Meteor.user().loginIdentities) {
      throw new Meteor.Error(403, "Must be logged into an account to sign up as admin.");
    }

    Meteor.users.update({ _id: this.userId }, { $set: { isAdmin: true, signupKey: "admin" } });
    clearAdminToken(token);
  },

  redeemSetupToken(token) {
    // Redeem an admin token into a setup session.
    check(token, String);
    if (tokenIsValid(token)) {
      const sessId = Random.secret();
      const creationDate = new Date();
      const hashedSessionId = Crypto.createHash("sha256").update(sessId).digest("base64");
      this.connection.sandstormDb.collections.setupSession.upsert({
        _id: "current-session",
      }, {
        creationDate,
        hashedSessionId,
      });
      // Then, invalidate the token, so one one else can use it.
      Fs.unlinkSync(SANDSTORM_ADMIN_TOKEN);
      return sessId;
    } else {
      throw new Meteor.Error(401, "Invalid setup token");
    }
  },
});

const authorizedAsAdmin = function (token, userId) {
  return Match.test(token, Match.OneOf(undefined, null, String)) &&
         ((userId && isAdminById(userId)) || tokenIsValid(token) || tokenIsSetupSession(token));
};

Meteor.publish("admin", function (token) {
  if (!authorizedAsAdmin(token, this.userId)) return [];
  return Settings.find();
});

Meteor.publish("adminServiceConfiguration", function (token) {
  if (!authorizedAsAdmin(token, this.userId)) return [];
  return Package["service-configuration"].ServiceConfiguration.configurations.find();
});

Meteor.publish("publicAdminSettings", function () {
  return Settings.find({ _id: { $in: publicAdminSettings } });
});

Meteor.publish("adminToken", function (token) {
  check(token, String);
  this.added("adminToken", "adminToken", { tokenIsValid: tokenIsValid(token) || tokenIsSetupSession(token) });
  this.ready();
});

Meteor.publish("allUsers", function (token) {
  if (!authorizedAsAdmin(token, this.userId)) return [];
  return Meteor.users.find();
});

Meteor.publish("activityStats", function (token) {
  if (!authorizedAsAdmin(token, this.userId)) return [];
  return ActivityStats.find();
});

Meteor.publish("statsTokens", function (token) {
  if (!authorizedAsAdmin(token, this.userId)) return [];
  return StatsTokens.find();
});

Meteor.publish("allPackages", function (token) {
  if (!authorizedAsAdmin(token, this.userId)) return [];
  return Packages.find({ manifest: { $exists: true } },
      { fields: { appId: 1, "manifest.appVersion": 1,
      "manifest.actions": 1, "manifest.appTitle": 1, }, });
});

Meteor.publish("realTimeStats", function (token) {
  if (!authorizedAsAdmin(token, this.userId)) return [];

  // Last five minutes.
  this.added("realTimeStats", "now", computeStats(new Date(Date.now() - 5 * 60 * 1000)));

  // Since last sample.
  const lastSample = ActivityStats.findOne({}, { sort: { timestamp: -1 } });
  const lastSampleTime = lastSample ? lastSample.timestamp : new Date(0);
  this.added("realTimeStats", "today", computeStats(lastSampleTime));

  // TODO(someday): Update every few minutes?

  this.ready();
});

Meteor.publish("adminLog", function (token) {
  if (!authorizedAsAdmin(token, this.userId)) return [];

  const logfile = SANDSTORM_LOGDIR + "/sandstorm.log";

  const fd = Fs.openSync(logfile, "r");
  const startSize = Fs.fstatSync(fd).size;

  // Start tailing at EOF - 8k.
  let offset = Math.max(0, startSize - 8192);

  const _this = this;
  function doTail() {
    for (;;) {
      const buf = new Buffer(Math.max(1024, startSize - offset));
      const n = Fs.readSync(fd, buf, 0, buf.length, offset);
      if (n <= 0) break;
      _this.added("adminLog", offset, { text: buf.toString("utf8", 0, n) });
      offset += n;
    }
  }

  // Watch the file for changes.
  const watcher = Fs.watch(logfile, { persistent: false }, Meteor.bindEnvironment(doTail));

  // When the subscription stops, stop watching the file.
  this.onStop(function () {
    watcher.close();
    Fs.closeSync(fd);
  });

  // Read initial 8k tail data immediately.
  doTail();

  // Notify ready.
  this.ready();
});

Meteor.publish("adminApiTokens", function (token) {
  if (!authorizedAsAdmin(token, this.userId)) return [];
  return ApiTokens.find({
    $or: [
      { "frontendRef.ipNetwork": { $exists: true } },
      { "frontendRef.ipInterface": { $exists: true } },
    ],
  }, {
    fields: {
      frontendRef: 1,
      created: 1,
      requirements: 1,
      revoked: 1,
    },
  });
});

Meteor.publish("featureKey", function (forAdmin, token) {
  if (forAdmin && !authorizedAsAdmin(token, this.userId)) return [];

  const fields = forAdmin ? FEATURE_KEY_FIELDS_PUBLISHED_TO_ADMINS
                          : PUBLIC_FEATURE_KEY_FIELDS;

  const db = this.connection.sandstormDb;
  const featureKeyQuery = db.collections.featureKey.find({ _id: "currentFeatureKey" });
  const observeHandle = featureKeyQuery.observe({
    added: (doc) => {
      // Load and verify the signed feature key.
      const buf = new Buffer(doc.value);
      const featureKey = loadSignedFeatureKey(buf);

      if (featureKey) {
        // If the signature is valid, publish the feature key information.
        const filteredFeatureKey = _.pick(featureKey, ...fields);
        this.added("featureKey", doc._id, filteredFeatureKey);
      }
    },

    changed: (newDoc, oldDoc) => {
      // Load and reverify the new signed feature key.
      const buf = new Buffer(newDoc.value);
      const featureKey = loadSignedFeatureKey(buf);

      if (featureKey) {
        // If the signature is valid, call this.changed() with the interesting fields.
        const filteredFeatureKey = _.pick(featureKey, ...fields);
        this.changed("featureKey", newDoc._id, filteredFeatureKey);
      } else {
        // Otherwise, call this.removed(), since the new feature key is invalid.
        this.removed("featureKey", oldDoc._id);
      }
    },

    removed: (oldDoc) => {
      this.removed("featureKey", oldDoc._id);
    },
  });

  this.onStop(() => {
    observeHandle.stop();
  });

  this.ready();
});

Meteor.publish("hasAdmin", function (token) {
  // Like hasUsers, but for admins, and with token auth required.
  if (!authorizedAsAdmin(token, this.userId)) return [];

  // Query if there are any admin users.
  const cursor = Meteor.users.find({ isAdmin: true });
  if (cursor.count() > 0) {
    this.added("hasAdmin", "hasAdmin", { hasAdmin: true });
  } else {
    let handle = cursor.observeChanges({
      added: (id) => {
        this.added("hasAdmin", "hasAdmin", { hasAdmin: true });
        handle.stop();
        handle = null;
      },
    });
    this.onStop(function () {
      if (handle) handle.stop();
    });
  }

  this.ready();
});

function observeOauthService(name) {
  Settings.find({ _id: name, value: true }).observe({
    added: function () {
      // Tell the oauth library it should accept login attempts from this service.
      Accounts.oauth.registerService(name);
    },

    removed: function () {
      // Tell the oauth library it should deny login attempts from this service.
      Accounts.oauth.unregisterService(name);
    },
  });
}

observeOauthService("github");
observeOauthService("google");
