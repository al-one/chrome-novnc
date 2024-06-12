window.onstorage = (event) => {
  if (event.key === "np_token") {
    chrome.runtime.sendMessage({
      np_token: event.newValue,
    });
  }
};

window.onload = () => {
  let token = localStorage.getItem("np_token");
  if (token) {
    chrome.runtime.sendMessage({
      np_token: token,
    });
  }
};
