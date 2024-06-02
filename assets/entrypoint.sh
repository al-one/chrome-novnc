#!/bin/bash

CONFIG_PATH=~/.config/chromium
rm -f "$CONFIG_PATH/SingletonLock"

exec "$@"
