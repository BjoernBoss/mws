/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libLog from "./log.js";

let _serverName = '';
export function setServerName(name: string): void {
	_serverName = name;
	libLog.Info(`Server name configured as: [${_serverName}]`);
}
export function getServerName(): string {
	return _serverName;
}

/* initialize the default configuration */
export function initialize(): void {
	setServerName('modular-web-server');
}
