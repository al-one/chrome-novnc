/* eslint-disable no-restricted-globals */
/* eslint-disable no-undef */
/* eslint-disable no-param-reassign */
/* eslint-disable no-var */
/* eslint-disable vars-on-top */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-use-before-define */
/* eslint-disable camelcase */

const getUnixTimestamp = () => Math.floor(Date.now() / 1000);

const isUUID = (id) => typeof id === "string" && id.length === 36;

const generateRandomNumber = () => {
  const randomNumber = Math.random() * 100000000;
  return Math.floor(randomNumber);
};

let websocket = false;
let lastLiveConnectionTimestamp = getUnixTimestamp();
let retries = 0;
const PING_INTERVAL = 2 * 60 * 1000; // 2 minutes

const HEADERS_TO_REPLACE = [
  "origin",
  "referer",
  "access-control-request-headers",
  "access-control-request-method",
  "access-control-allow-origin",
  "cookie",
  "date",
  "dnt",
  "trailer",
  "upgrade",
];

const DEFAULT_STORAGE_KEY_EXPIRE_MS = 10 * 60 * 1000;
const DEFAULT_STORAGE_EXPIRATION_CHECK = 60 * 1000;
const FETCH_TIMEOUT = 10 * 1000;
const REDIRECT_DATA_TIMEOUT = 5 * 1000;
const RESPONSE_COOKIE_TIMEOUT = 5 * 1000;

const CHROME_PING_INTERVAL = 3 * 1000;
const WEBSOCKET_URLS = [
  "wss://proxy2.wynd.network:4650",
  "wss://proxy2.wynd.network:4444",
];

const RPC_CALL_TABLE = {
  HTTP_REQUEST: performHttpRequest,
  AUTH: authenticate,
  PONG: () => {},
};

const BROWSER_ID_KEY = "wynd:browser_id";
const USER_ID_KEY = "wynd:user_id";
const JWT_KEY = "wynd:jwt";
const STATUS_KEY = "wynd:status";
const DEVICE_KEY = "wynd:device";
const USER_KEY = "wynd:user";
const AUTHENTICATED_KEY = "wynd:authenticated";
const SETTINGS_KEY = "wynd:settings";
const POPUP_STATE_KEY = "wynd:popup";
const PERMISSIONS_KEY = "wynd:permissions";
const ACCESS_TOKEN_KEY = "accessToken";
const REFRESH_TOKEN_KEY = "refreshToken";
const USERNAME_KEY = "username";
const EMAIL_KEY = "email";

const STATUSES = {
  CONNECTED: "CONNECTED",
  DISCONNECTED: "DISCONNECTED",
  DEAD: "DEAD",
  CONNECTING: "CONNECTING",
};

class Mutex {
  #queue;
  #isLocked;

  constructor() {
    this.#queue = [];
    this.#isLocked = false;
  }

  async runExclusive(callback) {
    const release = await this.#acquire();
    try {
      return await callback();
    } finally {
      release();
    }
  }

  #acquire() {
    return new Promise((resolve) => {
      this.#queue.push({ resolve });
      this.#dispatch();
    });
  }

  #dispatch() {
    if (this.#isLocked) {
      return;
    }
    const nextEntry = this.#queue.shift();
    if (!nextEntry) {
      return;
    }
    this.#isLocked = true;
    nextEntry.resolve(this.#buildRelease());
  }

  #buildRelease() {
    return () => {
      this.#isLocked = false;
      this.#dispatch();
    };
  }
}

class LogsTransporter {
  static sendLogs(logs) {
    websocket.send(
      JSON.stringify({
        action: "LOGS",
        data: logs,
      })
    );
  }
}

class CustomStorage {
  #defaultExpireMs;
  #storage;

  constructor(defaultExpireMs = DEFAULT_STORAGE_KEY_EXPIRE_MS) {
    this.#defaultExpireMs = defaultExpireMs;
    this.#storage = {};
    const clearExpiredInterval = setInterval(() => {
      this.#clearExpired();
    }, DEFAULT_STORAGE_EXPIRATION_CHECK);
  }

  get(key) {
    this.#checkKeyIsExpired(key);
    return this.#storage[key]?.value ?? null;
  }

  set(key, value, exMs = null) {
    const expirationTimeMs = exMs ?? this.#defaultExpireMs;
    const data = {
      value,
      metainfo: {
        expire_at: Date.now() + expirationTimeMs,
      },
    };
    this.#storage[key] = data;
  }

  del(key) {
    delete this.#storage[key];
  }

  exists(key) {
    this.#checkKeyIsExpired(key);
    return this.#storage[key] !== null && this.#storage[key] !== undefined;
  }

  #clearExpired() {
    Object.keys(this.#storage).forEach((key) => {
      this.#checkKeyIsExpired(key);
    });
  }

  #checkKeyIsExpired(key) {
    const data = this.#storage[key];
    if (
      data === null ||
      data === undefined ||
      Date.now() > data.metainfo.expire_at
    ) {
      delete this.#storage[key];
    }
  }
}

class ResponseProcessor {
  #cookieMutex;
  #redirectMutex;
  #waitCookieTasks;
  #waitRedirectTasks;
  #cookieStorage;
  #redirectDataStorage;

  constructor() {
    this.#cookieMutex = new Mutex();
    this.#redirectMutex = new Mutex();
    this.#waitCookieTasks = new CustomStorage();
    this.#waitRedirectTasks = new CustomStorage();
    this.#cookieStorage = new CustomStorage();
    this.#redirectDataStorage = new CustomStorage();
  }

  async getResponseCookies(requestId, timeoutMs) {
    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(async () => {
        await this.#cookieMutex.runExclusive(() => {
          this.#waitCookieTasks.del(requestId);
          LogsTransporter.sendLogs(
            `Timeout Error: Could not get Cookies from response to request ${requestId}`
          );
          reject(
            `Timeout Error: Could not get Cookies from response to request ${requestId}`
          );
        });
      }, timeoutMs);

      await this.#cookieMutex.runExclusive(() => {
        const cookies = this.#cookieStorage.get(requestId);
        if (cookies !== null) {
          clearTimeout(timeout);
          resolve(cookies);
        } else {
          this.#waitCookieTasks.set(requestId, (c) => {
            clearTimeout(timeout);
            resolve(c);
          });
        }
      });
    });
  }

  async setResponseCookies(requestId, cookies) {
    return this.#cookieMutex.runExclusive(() => {
      const resolve = this.#waitCookieTasks.get(requestId);
      if (resolve) {
        resolve(cookies);
        this.#waitCookieTasks.del(requestId);
      } else {
        this.#cookieStorage.set(requestId, cookies);
      }
    });
  }

  async setRedirectData(requestId, redirectData) {
    return this.#redirectMutex.runExclusive(() => {
      const resolve = this.#waitRedirectTasks.get(requestId);
      if (resolve) {
        resolve(redirectData);
        this.#waitRedirectTasks.del(requestId);
      } else {
        this.#redirectDataStorage.set(requestId, redirectData);
      }
    });
  }

  async getRedirectData(requestId, timeoutMs) {
    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(async () => {
        await this.#redirectMutex.runExclusive(() => {
          this.#waitRedirectTasks.del(requestId);
          LogsTransporter.sendLogs(
            `Timeout Error: Could not get Redirect data from response to request ${requestId}`
          );
          reject(
            `Timeout Error: Could not get Redirect data from response to request ${requestId}`
          );
        });
      }, timeoutMs);

      await this.#redirectMutex.runExclusive(() => {
        const redirectData = this.#redirectDataStorage.get(requestId);
        if (redirectData !== null) {
          clearTimeout(timeout);
          resolve(redirectData);
        } else {
          this.#waitRedirectTasks.set(requestId, (data) => {
            clearTimeout(timeout);
            resolve(data);
          });
        }
      });
    });
  }

  async registerOnErrorOccuredEvent(requestId) {
    return this.setResponseCookies(requestId, "");
  }
}

class RequestFetcher {
  #usedChromeRequestIds;
  #resolve;

  #webRequestMutex;
  #fetchMutex;

  constructor() {
    this.#usedChromeRequestIds = new CustomStorage();
    this.#resolve = null;
    this.#webRequestMutex = new Mutex();
    this.#fetchMutex = new Mutex();
  }

  async fetch(url, requestOptions) {
    return this.#fetchMutex.runExclusive(() => {
      return new Promise(async (resolve, reject) => {
        let responsePromise = null;
        const timeout = setTimeout(async () => {
          await this.#webRequestMutex.runExclusive(() => {
            this.#resolve = null;
            LogsTransporter.sendLogs(
              `Resolved WITHOUT REQUEST ID: ${url}, ${JSON.stringify(
                requestOptions
              )}`
            );
            resolve({
              requestId: null,
              responsePromise,
            });
          });
        }, FETCH_TIMEOUT);
        await this.#webRequestMutex.runExclusive(() => {
          if (this.#resolve) {
            this.#resolve = null;
            clearTimeout(timeout);
            LogsTransporter.sendLogs(
              `Inconsistency detected. Waiting for more than 1 requestId: ${url}, ${JSON.stringify(
                requestOptions
              )}`
            );
            reject(
              `Inconsistency detected. Waiting for more than 1 requestId.`
            );
          }
          responsePromise = fetch(url, requestOptions).catch((e) => {
            LogsTransporter.sendLogs(
              `Fetch error for ${url} ${JSON.stringify(
                requestOptions
              )} : ${e}, ${e.stack}`
            );
            throw e;
          });
          this.#resolve = (requestId) => {
            clearTimeout(timeout);
            return resolve({ requestId, responsePromise });
          };
        });
      });
    });
  }

  async registerOnBeforeRequestEvent(requestId) {
    return this.#webRequestMutex.runExclusive(() => {
      if (!this.#usedChromeRequestIds.exists(requestId)) {
        this.#processNewRequestId(requestId);
      }
    });
  }

  async registerOnBeforeRedirectEvent(requestId) {
    return this.#webRequestMutex.runExclusive(() => {
      if (!this.#usedChromeRequestIds.exists(requestId)) {
        this.#processNewRequestId(requestId);
      }
    });
  }

  async registerOnCompletedEvent(requestId) {
    return this.#webRequestMutex.runExclusive(async () => {
      if (!this.#usedChromeRequestIds.exists(requestId)) {
        this.#processNewRequestId(requestId);
      }
    });
  }

  async registerOnErrorOccuredEvent(requestId) {
    return this.#webRequestMutex.runExclusive(async () => {
      if (!this.#usedChromeRequestIds.exists(requestId)) {
        this.#processNewRequestId(requestId);
      } else {
        await RESPONSE_PROCESSOR.registerOnErrorOccuredEvent(requestId);
      }
    });
  }

  #processNewRequestId(requestId) {
    this.#usedChromeRequestIds.set(requestId, 1);
    const resolve = this.#resolve;
    this.#resolve = null;
    resolve(requestId);
  }
}

const validateJWT = (jwt) => {
  websocket.send(JSON.stringify({ jwt, action: "VALIDATE_JWT" }));
};

const parseValue = (value) => {
  try {
    return JSON.parse(value);
  } catch (e) {
    return value;
  }
};

function getLocalStorage(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local
      .get([key])
      .then((data) => {
        resolve(parseValue(data[key]));
      })
      .catch(reject);
  });
}

function setLocalStorage(key, value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local
      .set({ [key]: JSON.stringify(value) })
      .then(() => {
        resolve();
      })
      .catch(reject);
  });
}

async function authenticate() {
  let browser_id = await getLocalStorage(BROWSER_ID_KEY);
  const user_id = await getLocalStorage(USER_ID_KEY);
  const version = chrome.runtime.getManifest().version;
  const extension_id = chrome?.runtime?.id;

  if (!isUUID(browser_id)) {
    return;
  }

  const authenticationResponse = {
    browser_id,
    user_id: null,
    user_agent: navigator.userAgent,
    timestamp: getUnixTimestamp(),
    device_type: "extension",
    version,
    extension_id,
  };

  if (Boolean(user_id)) {
    authenticationResponse.user_id = user_id;
  }

  return authenticationResponse;
}

function uuidv4() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (
      c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))
    ).toString(16)
  );
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

const websocket_check_interval = setInterval(async () => {
  const PENDING_STATES = [0, 2];

  if (websocket) {
    if (websocket.readyState === 1) {
      await setLocalStorage(STATUS_KEY, STATUSES.CONNECTED);
    } else if (websocket.readyState === 3) {
      await setLocalStorage(STATUS_KEY, STATUSES.DISCONNECTED);
    }
  }

  if (PENDING_STATES.includes(websocket.readyState)) {
    console.log("WebSocket not in appropriate state for liveness check...");
    return;
  }

  const current_timestamp = getUnixTimestamp();
  const seconds_since_last_live_message =
    current_timestamp - lastLiveConnectionTimestamp;

  if (seconds_since_last_live_message > 129 || websocket.readyState === 3) {
    console.error(
      "WebSocket does not appear to be live! Restarting the WebSocket connection..."
    );

    try {
      websocket.close();
    } catch (e) {}
    initialize();
    return;
  }

  websocket.send(
    JSON.stringify({
      id: uuidv4(),
      version: "1.0.0",
      action: "PING",
      data: {},
    })
  );
}, PING_INTERVAL);

const RESPONSE_PROCESSOR = new ResponseProcessor();
const REQUEST_FETCHER = new RequestFetcher();

async function performHttpRequest(params) {
  const replacedRequestHeaders = Object.keys(params.headers)
    .filter((headerKey) => {
      return HEADERS_TO_REPLACE.includes(headerKey.toLowerCase());
    })
    .map((headerKey) => {
      return {
        header: headerKey,
        operation: "set",
        value: params.headers[headerKey],
      };
    });

  const newRuleIds = [];
  if (replacedRequestHeaders.length > 0) {
    const newRuleId = generateRandomNumber();
    newRuleIds.push(newRuleId);
    const newRule = {
      id: newRuleId,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: replacedRequestHeaders,
      },
      condition: {
        urlFilter: `${params.url.replace(/\/$/, "")}`,
        tabIds: [chrome.tabs.TAB_ID_NONE],
      },
    };
    chrome.declarativeNetRequest.updateSessionRules({
      addRules: [newRule],
    });
  }

  const request_options = {
    method: params.method,
    mode: "cors",
    cache: "no-cache",
    credentials: "omit",
    headers: params.headers,
    redirect: "manual",
  };

  if (params.body) {
    const fetchURL = `data:application/octet-stream;base64,${params.body}`;
    const fetchResp = await fetch(fetchURL);
    request_options.body = await fetchResp.blob();
  }

  const { requestId, responsePromise } = await REQUEST_FETCHER.fetch(
    params.url,
    request_options
  ).catch((e) => {
    console.error(`Error occurred while extracting requestId: ${e}`);
    LogsTransporter.sendLogs(
      `Error occurred while extracting requestId ${
        params.url
      }, ${JSON.stringify(request_options)}: ${e}, ${e.stack}`
    );
    return { requestId: undefined, responsePromise: undefined };
  });

  if (responsePromise === undefined) {
    return null;
  }

  const response = await responsePromise.catch((e) => {
    console.error(`Error occurred while performing fetch: ${e}`);
    LogsTransporter.sendLogs(
      `Error occurred while performing fetch <${requestId}> ${
        params.url
      }, ${JSON.stringify(request_options)}: ${e}, ${e.stack}`
    );
  });

  if (newRuleIds) {
    chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: newRuleIds,
    });
  }

  if (!response) {
    return {
      url: params.url,
      status: 400,
      status_text: "Bad Request",
      headers: {},
      body: "",
    };
  }

  if (response.type === "opaqueredirect") {
    if (!requestId) {
      console.error(`No requestId for redirect.`);
      LogsTransporter.sendLogs(
        `Error occurred in redirect ${params.url}, ${JSON.stringify(
          request_options
        )}: No requestId for redirect`
      );
      return null;
    }
    const redirectResponse = await RESPONSE_PROCESSOR.getRedirectData(
      requestId,
      REDIRECT_DATA_TIMEOUT
    )
      .then((redirectData) => {
        const responseMetadata = JSON.parse(redirectData);
        if (Object.hasOwn(responseMetadata.headers, "Set-Cookie")) {
          responseMetadata.headers["Set-Cookie"] = JSON.parse(
            responseMetadata.headers["Set-Cookie"]
          );
        }
        return {
          url: response.url,
          status: responseMetadata.statusCode,
          status_text: "Redirect",
          headers: responseMetadata.headers,
          body: "",
        };
      })
      .catch((e) => {
        console.error(
          `Error occured while processing redirect metadata : ${e}`
        );
        LogsTransporter.sendLogs(
          `Error occured while processing redirect metadata <${requestId}> ${
            params.url
          }, ${JSON.stringify(request_options)}: ${e}, ${e.stack}`
        );
        return null;
      });
    return redirectResponse;
  }

  const headers = {};

  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "content-encoding") {
      headers[key] = value;
    }
  });

  if (requestId) {
    await RESPONSE_PROCESSOR.getResponseCookies(
      requestId,
      RESPONSE_COOKIE_TIMEOUT
    )
      .then((responseCookies) => {
        if (responseCookies !== "") {
          const cookies = JSON.parse(responseCookies);
          if (cookies.length !== 0) {
            headers["Set-Cookie"] = cookies;
          }
        }
      })
      .catch((e) => {
        console.error(`Error occured while processing response cookies: ${e}`);
        LogsTransporter.sendLogs(
          `Error occured while processing response cookies <${requestId}> ${
            params.url
          }, ${JSON.stringify(request_options)}: ${e}, ${e.stack}`
        );
      });
  }

  return {
    url: response.url,
    status: response.status,
    status_text: response.statusText,
    headers: headers,
    body: arrayBufferToBase64(await response.arrayBuffer()),
  };
}

chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (details.initiator !== location.origin.toString()) {
      return;
    }
    await REQUEST_FETCHER.registerOnBeforeRequestEvent(details.requestId);
  },
  { urls: ["<all_urls>"] },
  []
);

function extractCookies(responseHeaders) {
  const cookies = [];
  responseHeaders.forEach((header) => {
    if (header.name.toLowerCase() === "set-cookie") {
      if (Object.hasOwn(header, "value")) {
        cookies.push(header.value);
      } else if (Object.hasOwn(header, "binaryValue")) {
        cookies.push(header.binaryValue);
      }
    }
  });
  return cookies;
}

chrome.webRequest.onBeforeRedirect.addListener(
  async (details) => {
    if (details.initiator !== location.origin.toString()) {
      return;
    }
    const responseHeaders = {};
    details.responseHeaders.forEach((header) => {
      if (header.name.toLowerCase() !== "set-cookie") {
        if (Object.hasOwn(header, "value")) {
          responseHeaders[header.name] = header.value;
        } else if (Object.hasOwn(header, "binaryValue")) {
          responseHeaders[header.name] = header.binaryValue;
        }
      }
    });
    const cookies = extractCookies(details.responseHeaders);
    if (cookies.length !== 0) {
      responseHeaders["Set-Cookie"] = JSON.stringify(cookies);
    }
    await REQUEST_FETCHER.registerOnBeforeRedirectEvent(details.requestId);
    await RESPONSE_PROCESSOR.setRedirectData(
      details.requestId,
      JSON.stringify({
        statusCode: details.statusCode,
        headers: responseHeaders,
      })
    );
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    if (details.initiator !== location.origin.toString()) {
      return;
    }
    const cookies = extractCookies(details.responseHeaders);
    await REQUEST_FETCHER.registerOnCompletedEvent(details.requestId);
    await RESPONSE_PROCESSOR.setResponseCookies(
      details.requestId,
      JSON.stringify(cookies)
    );
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
);

chrome.webRequest.onErrorOccurred.addListener(
  async (details) => {
    if (details.initiator !== location.origin.toString()) {
      return;
    }
    LogsTransporter.sendLogs(
      `onErrorOccured, ${details.requestId}, ${details.url}, ${details.error}`
    );
    await REQUEST_FETCHER.registerOnErrorOccuredEvent(details.requestId);
  },
  { urls: ["<all_urls>"] },
  []
);

async function initialize() {
  const browserId = await getLocalStorage(BROWSER_ID_KEY);
  if (!browserId) {
    console.warn("[INITIALIZE] Browser ID is blank. Cancelling connection...");
    return;
  }

  const hasPermissions = await getLocalStorage(PERMISSIONS_KEY);
  if (!hasPermissions) {
    console.warn(
      "[INITIALIZE] Permissions is disabled. Cancelling connection..."
    );
    return;
  }

  const websocketUrl = WEBSOCKET_URLS[retries % WEBSOCKET_URLS.length];
  websocket = new WebSocket(websocketUrl);

  websocket.onopen = async function (e) {
    console.log("Websocket Open");
    lastLiveConnectionTimestamp = getUnixTimestamp();
    await setLocalStorage(STATUS_KEY, STATUSES.CONNECTED);
  };

  websocket.onmessage = async function (event) {
    lastLiveConnectionTimestamp = getUnixTimestamp();

    let parsed_message;
    try {
      parsed_message = JSON.parse(event.data);
    } catch (e) {
      console.error("Could not parse WebSocket message!", event.data);
      console.error(e);
      return;
    }

    if (parsed_message.action in RPC_CALL_TABLE) {
      try {
        const result = await RPC_CALL_TABLE[parsed_message.action](
          parsed_message.data
        );
        websocket.send(
          JSON.stringify({
            id: parsed_message.id,
            origin_action: parsed_message.action,
            result: result,
          })
        );
      } catch (e) {
        LogsTransporter.sendLogs(
          `RPC encountered error for message ${JSON.stringify(
            parsed_message
          )}: ${e}, ${e.stack}`
        );
        console.error(
          `RPC action ${parsed_message.action} encountered error: `,
          e
        );
      }
    } else {
      console.error(`No RPC action ${parsed_message.action}!`);
    }
  };

  websocket.onclose = async function (event) {
    if (event.wasClean) {
      console.log(
        `[close] Connection closed cleanly, code=${event.code} reason=${event.reason}`
      );
    } else {
      console.log("[close] Connection died");
      await setLocalStorage(STATUS_KEY, STATUSES.DEAD);
      retries++;
    }
  };

  websocket.onerror = function (error) {
    console.log(error);
    console.log(`[error] ${error}`);
  };
}

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message) {
    switch (message) {
      case "ping":
        sendResponse("pong");
        return;
      case "reconnect":
        try {
          websocket.close();
        } catch (e) {}
        await setLocalStorage(STATUS_KEY, STATUSES.CONNECTING);
        console.log("[RECONNECT] Reconnecting...");
        await initialize();
        sendResponse("Reconnecting...");
        return;
      case "disconnect":
        try {
          websocket.close();
        } catch (e) {}
        await setLocalStorage(STATUS_KEY, STATUSES.DISCONNECTED);
        sendResponse("Disconnected...");
        return;
      default:
        hasToken = true;
        await setLocalStorage(JWT_KEY, message);
        validateJWT(message);
        sendResponse({ success: true });
        return;
    }
  }
  sendResponse({ success: false });
  return;
});

chrome.runtime.onMessageExternal.addListener(
  async (request, sender, sendResponse) => {
    const { type, payload } = request;

    if (type) {
      switch (type) {
        case "setAccessToken":
          await setLocalStorage(ACCESS_TOKEN_KEY, payload);
          return;
        case "setRefreshToken":
          await setLocalStorage(REFRESH_TOKEN_KEY, payload);
          return;
        case "getBrowserId":
          const browserId = await getLocalStorage(BROWSER_ID_KEY);
          sendResponse(browserId);
          return;
        case "getUserId":
          const userId = await getLocalStorage(USER_ID_KEY);
          sendResponse(userId);
          return;
        case "setUserId":
          await setLocalStorage(USER_ID_KEY, payload);
          return;
        case "setIsAuthenticated":
          await setLocalStorage(AUTHENTICATED_KEY, payload);
          return;
        case "reconnect":
          const popupState = await getLocalStorage(POPUP_STATE_KEY);
          if (!popupState) {
            try {
              websocket.close(1000, "Dashboard Request");
            } catch (e) {}
            await initialize();
          }
          return;
        case "updateUsername":
          await setLocalStorage(USERNAME_KEY, payload);
          return;
        case "clearStorage":
          await setLocalStorage(USER_KEY, null);
          await setLocalStorage(USERNAME_KEY, "");
          await setLocalStorage(EMAIL_KEY, "");
          await setLocalStorage(AUTHENTICATED_KEY, false);
          await setLocalStorage(DEVICE_KEY, null);
          await setLocalStorage(SETTINGS_KEY, null);
          await setLocalStorage(ACCESS_TOKEN_KEY, "");
          await setLocalStorage(REFRESH_TOKEN_KEY, "");
          sendResponse("Storage has been cleared");
          return;
        default:
          return;
      }
    }

    sendResponse("NULL request");
    return;
  }
);

chrome.runtime.onConnect.addListener(async (port) => {
  if (port.name === "popup") {
    await setLocalStorage(POPUP_STATE_KEY, true);

    port.onDisconnect.addListener(async () => {
      await setLocalStorage(POPUP_STATE_KEY, false);
    });
  }
});

chrome.storage.onChanged.addListener(async (changes) => {
  if (changes[USER_ID_KEY]) {
    const newUserId = await getLocalStorage(USER_ID_KEY);
    if (!!newUserId) {
      try {
        await setLocalStorage(STATUS_KEY, STATUSES.CONNECTING);
        websocket.close(1000, "Reconnecting");
      } catch (e) {}
      await initialize();
    } else if (!newUserId) {
      try {
        websocket.close(1000, "Blank User ID");
      } catch (e) {}
    }
  }
});

chrome.runtime.onUpdateAvailable.addListener(function (details) {
  console.log("Updating to version " + details.version);
  chrome.runtime.reload();
});

const checkPermissions = async () => {
  chrome.permissions.getAll(async (permissions) => {
    if (permissions.origins.includes("<all_urls>")) {
      await setLocalStorage(PERMISSIONS_KEY, true);
      await setLocalStorage(STATUS_KEY, STATUSES.CONNECTING);
      try {
        websocket.close();
      } catch (e) {}
      initialize();
    } else {
      await setLocalStorage(PERMISSIONS_KEY, false);
      await websocket.close(1000, "Modified permissions");
    }
  });
};

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.action === "getCurrentVersion") {
    sendResponse({ version: chrome.runtime.getManifest().version });
  }
});

checkPermissions();
chrome.permissions.onAdded.addListener(checkPermissions);
chrome.permissions.onRemoved.addListener(checkPermissions);

const keepAlive = () => {
  chrome.runtime.sendMessage("ping");
};

setInterval(() => {
  keepAlive();
}, CHROME_PING_INTERVAL);
