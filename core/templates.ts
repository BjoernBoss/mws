/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libLog from "./log.js";
import * as libFs from "fs";
import * as libPath from "path";

function LoadRelative(path: string): string {
	/* workaround! (7 => file://) */
	const dirName = import.meta.dirname ?? libPath.dirname(import.meta.url.slice(7));
	if (path.startsWith('/'))
		path = libPath.join(dirName, '.' + path);
	if (!path.startsWith('./'))
		path = libPath.join(dirName, './' + path);
	else
		path = libPath.join(dirName, path);

	/* try to load the actual file */
	return libFs.readFileSync(path, 'utf-8');
}
function ExpandPlaceholders(content: string, map: Record<string, string>): string {
	var out = '', name = '';

	/* construct the new output content */
	var inName = false;
	for (var i = 0; i < content.length; ++i) {
		/* check if this is the start/end of a placeholder */
		if (content[i] != '{' && content[i] != '}') {
			if (inName)
				name += content[i];
			else
				out += content[i];
			continue;
		}

		/* check if the curly bracket is escaped */
		if (i + 1 < content.length && content[i] == content[i + 1]) {
			if (inName)
				name += content[i];
			else
				out += content[i];
			++i;
			continue;
		}

		/* check if a name is being started */
		if (content[i] == '{') {
			if (!inName)
				name = '';
			else
				libLog.Warning('Unescaped opening curly bracket encountered');
			inName = true;
			continue;
		}

		/* check if a name has been completed */
		if (!inName)
			libLog.Warning('Unescaped closing curly bracket encountered');
		else if (!(name in map))
			libLog.Warning(`Undefined placeholder [${name}] encountered`);
		else {
			var value = map[name];
			if (typeof (value) != 'string')
				libLog.Warning(`Placeholder [${name}] is not a string`);
			else
				out += value;
		}
		inName = false;
	}

	/* check if a last name was not closed properly */
	if (inName)
		libLog.Warning('Content ends with an incomplete placeholder');
	return out;
};

export function SuccessOk(payload: { path: string, operation: string }): string {
	const content: string = LoadRelative('templates/200.html');
	return ExpandPlaceholders(content, { path: payload.path, op: payload.operation });
}

export function PermanentlyMoved(payload: { path: string, destination: string }): string {
	const content: string = LoadRelative('templates/301.html');
	return ExpandPlaceholders(content, { path: payload.path, new: payload.destination });
}

export function TemporaryRedirect(payload: { path: string, destination: string }): string {
	const content: string = LoadRelative('templates/307.html');
	return ExpandPlaceholders(content, { path: payload.path, new: payload.destination });
}

export function ErrorBadRequest(payload: { path: string, reason: string }): string {
	const content: string = LoadRelative('templates/400.html');
	return ExpandPlaceholders(content, { path: payload.path, reason: payload.reason });
}

export function ErrorNotFound(payload: { path: string }): string {
	const content: string = LoadRelative('templates/404.html');
	return ExpandPlaceholders(content, { path: payload.path });
}

export function ErrorInvalidMethod(payload: { path: string, method: string, allowed: string[] }): string {
	const content: string = LoadRelative('templates/405.html');
	return ExpandPlaceholders(content, { path: payload.path, method: payload.method, allowed: payload.allowed.join(",") });
}

export function ErrorConflict(payload: { path: string, conflict: string }): string {
	const content: string = LoadRelative('templates/409.html');
	return ExpandPlaceholders(content, { path: payload.path, conflict: payload.conflict });
}

export function ErrorContentTooLarge(payload: { path: string, allowedLength: number, providedLength: number }): string {
	const content: string = LoadRelative('templates/413.html');
	return ExpandPlaceholders(content, { path: payload.path, allowed: payload.allowedLength.toString(), length: payload.providedLength.toString() });
}

export function ErrorUnsupportedMediaType(payload: { path: string, allowed: string[], used: string }): string {
	const content: string = LoadRelative('templates/415.html');
	return ExpandPlaceholders(content, { path: payload.path, used: payload.used, allowed: payload.allowed.join(",") });
}

export function ErrorRangeIssue(payload: { path: string, range: string, fileSize: number }): string {
	const content: string = LoadRelative('templates/416.html');
	return ExpandPlaceholders(content, { path: payload.path, range: payload.range, size: payload.fileSize.toString() });
}

export function Expand(content: string, args: Record<string, string>) {
	return ExpandPlaceholders(content, args);
};
