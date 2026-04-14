/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libLog from "./log.js";
import * as libLocation from "./location.js";
import * as libCache from "./cache.js";

const RelativeBasePath = libLocation.MakeSelfPath(import.meta.url);
function LoadRelative(path: string): string {
	try {
		const data: Buffer | undefined = libCache.CachedFile.make(RelativeBasePath(path), { persistent: true })?.read();
		if (data != null)
			return data.toString('utf-8');
	} catch (_) { }

	/* return the default place-holder */
	libLog.Error(`Template [${path}] not found`);
	return '<!doctype html><html><body><p style="font-family: monospace;">Response message not found.</p></body></html>';
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

/* html formatted template message for error */
export function SuccessOk(payload: { path: string, operation: string }): string {
	const content: string = LoadRelative('templates/200.template');
	return ExpandPlaceholders(content, { path: payload.path, op: payload.operation });
}

/* html formatted template message for error */
export function PermanentlyMoved(payload: { path: string, destination: string }): string {
	const content: string = LoadRelative('templates/301.template');
	return ExpandPlaceholders(content, { path: payload.path, new: payload.destination });
}

/* html formatted template message for error */
export function TemporaryRedirect(payload: { path: string, destination: string }): string {
	const content: string = LoadRelative('templates/307.template');
	return ExpandPlaceholders(content, { path: payload.path, new: payload.destination });
}

/* html formatted template message for error */
export function ErrorBadRequest(payload: { path: string, reason: string }): string {
	const content: string = LoadRelative('templates/400.template');
	return ExpandPlaceholders(content, { path: payload.path, reason: payload.reason });
}

/* html formatted template message for error */
export function ErrorNotFound(payload: { path: string }): string {
	const content: string = LoadRelative('templates/404.template');
	return ExpandPlaceholders(content, { path: payload.path });
}

/* html formatted template message for error */
export function ErrorInvalidMethod(payload: { path: string, method: string, allowed: string[] }): string {
	const content: string = LoadRelative('templates/405.template');
	return ExpandPlaceholders(content, { path: payload.path, method: payload.method, allowed: payload.allowed.join(",") });
}

/* html formatted template message for error */
export function ErrorConflict(payload: { path: string, conflict: string }): string {
	const content: string = LoadRelative('templates/409.template');
	return ExpandPlaceholders(content, { path: payload.path, conflict: payload.conflict });
}

/* html formatted template message for error */
export function ErrorContentTooLarge(payload: { path: string, allowedLength: number, providedLength: number }): string {
	const content: string = LoadRelative('templates/413.template');
	return ExpandPlaceholders(content, { path: payload.path, allowed: payload.allowedLength.toString(), length: payload.providedLength.toString() });
}

/* html formatted template message for error */
export function ErrorUnsupportedMediaType(payload: { path: string, allowed: string[], used: string }): string {
	const content: string = LoadRelative('templates/415.template');
	return ExpandPlaceholders(content, { path: payload.path, used: payload.used, allowed: payload.allowed.join(",") });
}

/* html formatted template message for error */
export function ErrorRangeIssue(payload: { path: string, range: string, fileSize: number }): string {
	const content: string = LoadRelative('templates/416.template');
	return ExpandPlaceholders(content, { path: payload.path, range: payload.range, size: payload.fileSize.toString() });
}

/* expand the placeholders in the content (format: {name}, with '{' being escaped as '{{') */
export function Expand(content: string, args: Record<string, string>) {
	return ExpandPlaceholders(content, args);
};
