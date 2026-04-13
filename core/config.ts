/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libLog from "./log.js";

let _serverName = '';
export function SetServerName(name: string): void {
	_serverName = name;
	libLog.Info(`Server name configured as: [${_serverName}]`);
}
export function GetServerName(): string {
	return _serverName;
}

/* initialize the default configuration */
export function Initialize(): void {
	SetServerName('modular-web-server');
}
