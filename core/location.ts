/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2025-2026 Bjoern Boss Henrichsen */
import * as libUrl from "url";
import * as libPath from "path";

/* sanitize path and remove relative path components and convert it to an absolute path */
export function Sanitize(path: string, relative: boolean): string {
	/* treat the path as absolute, but preserve backward traversals into the root */
	let out = '/';
	if (path.startsWith('/'))
		relative = false;

	/* iterate over the characters and write them to the output
	*	(i == path.length is a final implicit slash to catch trailing '/..') */
	for (let i = 0; i <= path.length; ++i) {
		/* check if the character can just be written out */
		if (i < path.length && path[i] != '/' && path[i] != '\\') {
			out += path[i];
			continue;
		}

		/* check if the slash can be ignored as the string ends in a slash */
		if (out.endsWith('/'))
			continue;

		/* check if its a relative path step and remove it */
		if (out.endsWith('/.'))
			out = out.substring(0, out.length - 1);

		/* check if its just an arbitrary sequence */
		else if (!out.endsWith('/..')) {
			if (i + 1 >= path.length)
				break;
			out += '/';
		}

		/* process the backwards walking */
		else if (relative && (out.endsWith('/../..') || out == '/..')) {
			if (i < path.length)
				out += '/';
		}
		else if (!relative && out == '/..')
			out = '/';
		else
			out = out.substring(0, out.lastIndexOf('/', out.length - 4) + 1);
	}

	/* check if its not the root and remove trailing slashes and patch the relative path */
	if (out != '/') {
		if (out.endsWith('/'))
			out = out.substring(0, out.length - 1);
		if (relative)
			out = out.substring(1);
	}
	else if (relative)
		out = '.';
	return out;
}

/* join two paths into the sanitized absolute server path-environment */
export function JoinSanitized(a: string, b: string): string {
	if (a.length == 0 || b.length == 0)
		return Sanitize(a.length == 0 ? b : a, false);
	const aSlash = a.endsWith('/'), bSlash = b.startsWith('/');
	if (aSlash)
		return Sanitize(bSlash ? a + b.substring(1) : a + b, false);
	return Sanitize(bSlash ? a + b : `${a}/${b}`, false);
}

/* check if the sanitized path is a true sub-path of the sanitized base path (same root is also a sub-directory) */
export function IsSubDirectory(base: string, path: string): boolean {
	if (base.length > path.length)
		return false;
	if (base.length == path.length)
		return (base == path);
	if (!path.startsWith(base))
		return false;
	return (path[base.length] == '/' || base.endsWith('/'));
}

/* create path-creator, which returns sanitized paths relative to [path] */
export function MakeLocation(path: string): (path: string) => string {
	return function (p) {
		return libPath.join(path, Sanitize(p, false));
	};
}

/* create path-creator, which returns paths relative to the file url path (like the script itself using 'import.meta.url') and optionally the nested path [path] */
export function MakeSelfPath(urlFilePath: string, path: string | null = null): (path: string) => string {
	let dirName = libPath.dirname(libUrl.fileURLToPath(urlFilePath));
	if (path != null)
		dirName = libPath.join(dirName, Sanitize(path, true));
	return MakeLocation(dirName);
}

/* get the file extension of the path (returns the last dot and continuing, if there is more to the name before the dot; otherwise the empty string) */
export function GetFileExtension(path: string): string {
	let extension = '';
	for (let i = path.length; i >= 0 && (path[i] != '/' && path[i] != '\\'); --i) {
		if (extension != '')
			return extension;
		if (path[i] == '.')
			extension = path.substring(i);
	}
	return '';
}
