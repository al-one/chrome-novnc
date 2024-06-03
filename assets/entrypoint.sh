#!/bin/bash

CONFIG_PATH="$HOME/.config/chromium"
rm -fv "$CONFIG_PATH/SingletonLock"

exec "$@"
