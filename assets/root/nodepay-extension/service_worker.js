const WEBSOCKET_URL = "wss://nw.nodepay.ai:4576/websocket";
const RETRY_INTERVAL = 60000;
const PING_INTERVAL = 10000;
let retries = 0;
const CONNECTION_STATES = {
  CONNECTING: 0, //Socket has been created. The connection is not yet open.
  OPEN: 1, //The connection is open and ready to communicate.
  CLOSING: 2, //The connection is in the process of closing.
  CLOSED: 3, //The connection is closed or couldn't be opened.
};
let browserId;

let socket = false;
function toJson(resp) {
  if (resp.ok) {
    return resp.json();
  }

  return Promise.reject(resp);
}

const uuidv4 = () => {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (
      +c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))
    ).toString(16)
  );
};

const validResp = (resp) => {
  if (!resp || resp.code < 0) {
    return Promise.reject(resp);
  }
  return Promise.resolve(resp);
};

const callAPIInfo = (token) => {
  return fetch("https://sandbox-api.nodepay.ai/api/auth/session", {
    method: "POST",
    credentials: "include",
    headers: token
      ? {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        }
      : {
          "Content-Type": "application/json",
        },
  })
    .then(toJson)
    .then(validResp);
};

const parseValue = (value) => {
  try {
    return JSON.parse(value);
  } catch (e) {
    return value;
  }
};

chrome.runtime.onMessage.addListener(async function (
  request,
  sender,
  sendResponse
) {
  if (request["np_token"] || request["status_account"]) {
    chrome.storage.local.set({ np_token: request["np_token"] });
    const connectSocket = async () => {
      chrome.storage.sync.get(["browser_id"]).then((value) => {
        browserId = value.browser_id;
      });
      if (!browserId) {
        console.warn(
          "[INITIALIZE] Browser ID is blank. Cancelling connection..."
        );
        let id = uuidv4();
        browserId = id;
        chrome.storage.sync.set({ browser_id: id?.toString() });
        connectSocket();
        return;
      }
      if (
        socket &&
        [CONNECTION_STATES.OPEN, CONNECTION_STATES.CONNECTING].includes(
          socket.readyState
        )
      ) {
        console.warn("Socket already active or connecting");
        return;
      }
      socket = new WebSocket(WEBSOCKET_URL);

      socket.onopen = (event) => {
        retries = 0;
        chrome.storage.local.set({ status_ws: CONNECTION_STATES.OPEN });
      };

      socket.addEventListener("message", function (event) {
        let data = JSON.parse(event.data);
        if (data?.action === "PONG") {
          sendPong(data.id);
          setTimeout(() => {
            sendPing(data.id);
          }, PING_INTERVAL);
        } else if (data?.action == "AUTH") {
          callAPIInfo(request["np_token"]).then((res) => {
            if (res.code === 0 && res.data.uid) {
              chrome.storage.local.set({ accountInfo: res.data });
              let dataInfo = {
                user_id: res.data.uid,
                browser_id: browserId,
                user_agent: navigator.userAgent,
                timestamp: Math.floor(Date.now() / 1000),
                device_type: "extension",
                version: chrome.runtime.getManifest().version,
                token: request["np_token"],
                origin_action: "AUTH",
              };
              sendPing(data.id, dataInfo);
            }
          });
        }
      });

      socket.onclose = async function (event) {
        chrome.storage.local.set({ status_ws: CONNECTION_STATES.CLOSED });

        if (event.wasClean) {
          console.warn(`[close] Connection closed cleanly`);
        } else {
          console.warn("[close] Connection died");
          setTimeout(() => {
            connectSocket();
            retries++;
          }, RETRY_INTERVAL);
        }
      };
      socket.onerror = function (event) {
        chrome.storage.local.set({ status_ws: CONNECTION_STATES.CLOSED });
      };
    };

    const sendPing = (guid, options = {}) => {
      let payload = {
        id: guid,
        action: "PING",
        ...options,
      };

      try {
        if (socket?.readyState === CONNECTION_STATES.OPEN) {
          socket?.send(JSON.stringify(payload));
        }
      } catch (e) {
        //console.log("e",e)
      }
    };

    const sendPong = (guid) => {
      let payload = {
        id: guid,
        origin_action: "PONG",
      };
      try {
        if (socket?.readyState === CONNECTION_STATES.OPEN) {
          socket?.send(JSON.stringify(payload));
        }
      } catch (e) {
        //console.log("e",e)
      }
    };

    if (
      request["np_token"]?.length > 0 ||
      request?.["status_account"] !== "LOGOUT"
    ) {
      if (socket.readyState !== CONNECTION_STATES.OPEN) {
        connectSocket();
      }
    } else {
      chrome.storage.local.set({ status_ws: CONNECTION_STATES.CLOSED });
      socket?.close();
    }
  }
});

const checkPermission = async () => {
  chrome.storage.local.get(["np_token"]).then((data) => {
    let token = data?.["np_token"];
    if (token) {
      chrome.runtime.sendMessage({
        np_token: token,
      });
    } else {
      chrome.tabs.create({
        url: "https://app.nodepay.ai/dashboard",
        active: false,
      });
    }
  });
};

checkPermission();
