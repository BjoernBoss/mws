/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libLog from "./log.js";
import * as libLocation from "./location.js";
import * as libCache from "./cache.js";
import * as libBuilder from "./builder.js";

const logger = libLog.Logger('template');

const TemplateDirectory = libLocation.MakeSelfPath(import.meta.url, 'templates');
function LoadRelative(name: string): string {
	try {
		const data: Buffer | null = libCache.GetActual(TemplateDirectory(name), true)?.readSync() ?? null;
		if (data != null)
			return data.toString('utf-8');
	} catch (err: any) {
		logger.trace(`Error while loading template [${name}]: ${err.message}`);
	}

	/* return the default place-holder */
	logger.error(`Unable to load template [${name}] properly`);
	return '<!DOCTYPE html><html><body><p style="font-family: monospace;">Response message not found.</p></body></html>';
}

/* html formatted template message for success */
export function SuccessOk(payload: { path: string, operation: string }): string {
	const content: string = LoadRelative('200.template');
	return libBuilder.ExpandPlaceholders(content, { path: payload.path, op: payload.operation });
}

/* html formatted template message for redirect */
export function SeeOther(payload: { destination: string }): string {
	const content: string = LoadRelative('303.template');
	return libBuilder.ExpandPlaceholders(content, { new: payload.destination });
}

/* html formatted template message for redirect */
export function TemporaryRedirect(payload: { path: string, destination: string }): string {
	const content: string = LoadRelative('307.template');
	return libBuilder.ExpandPlaceholders(content, { path: payload.path, new: payload.destination });
}

/* html formatted template message for redirect */
export function PermanentRedirect(payload: { path: string, destination: string }): string {
	const content: string = LoadRelative('308.template');
	return libBuilder.ExpandPlaceholders(content, { path: payload.path, new: payload.destination });
}

/* html formatted template message for error */
export function ErrorPreconditionFailed(payload: { path: string, reason: string }): string {
	const content: string = LoadRelative('412.template');
	return libBuilder.ExpandPlaceholders(content, { path: payload.path, reason: payload.reason });
}

/* html formatted template message for error */
export function ErrorBadRequest(payload: { path: string, reason: string }): string {
	const content: string = LoadRelative('400.template');
	return libBuilder.ExpandPlaceholders(content, { path: payload.path, reason: payload.reason });
}

/* html formatted template message for error */
export function ErrorNotFound(payload: { path: string }): string {
	const content: string = LoadRelative('404.template');
	return libBuilder.ExpandPlaceholders(content, { path: payload.path });
}

/* html formatted template message for error */
export function ErrorInvalidMethod(payload: { path: string, method: string, allowed: string }): string {
	const content: string = LoadRelative('405.template');
	return libBuilder.ExpandPlaceholders(content, { path: payload.path, method: payload.method, allowed: payload.allowed });
}

/* html formatted template message for error */
export function ErrorConflict(payload: { path: string, conflict: string }): string {
	const content: string = LoadRelative('409.template');
	return libBuilder.ExpandPlaceholders(content, { path: payload.path, conflict: payload.conflict });
}

/* html formatted template message for error */
export function ErrorRequestTimeout(payload: { path: string, reason: string }): string {
	const content: string = LoadRelative('408.template');
	return libBuilder.ExpandPlaceholders(content, { path: payload.path, reason: payload.reason });
}

/* html formatted template message for error */
export function ErrorContentTooLarge(payload: { path: string, allowedLength: number, providedLength: number }): string {
	const content: string = LoadRelative('413.template');
	return libBuilder.ExpandPlaceholders(content, { path: payload.path, allowed: payload.allowedLength.toString(), size: payload.providedLength.toString() });
}

/* html formatted template message for error */
export function ErrorUnsupportedMediaType(payload: { path: string, allowed: string, used: string }): string {
	const content: string = LoadRelative('415.template');
	return libBuilder.ExpandPlaceholders(content, { path: payload.path, used: payload.used, allowed: payload.allowed });
}

/* html formatted template message for error */
export function ErrorRangeIssue(payload: { path: string, range: string, size: number }): string {
	const content: string = LoadRelative('416.template');
	return libBuilder.ExpandPlaceholders(content, { path: payload.path, range: payload.range, size: payload.size.toString() });
}

/* html formatted template message for error */
export function ErrorInternalServerError(payload: { path: string, what: string }): string {
	const content: string = LoadRelative('500.template');
	return libBuilder.ExpandPlaceholders(content, { path: payload.path, what: payload.what });
}
