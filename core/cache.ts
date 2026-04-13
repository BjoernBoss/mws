/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */
import * as libLog from "./log.js";
import * as libFs from "fs";
import * as libStream from "stream";

interface CacheEntry {
	data: Buffer;
	mtime: number;
	touched: number;
}
const cacheMap: Record<string, CacheEntry> = {};
let nextTouchStamp: number = 0, totalCacheSize: number = 0, totalCacheCapacity: number = 0, maxLargestSize: number = 0;

function CacheAdd(path: string, data: Buffer, mtime: number): void {
	if (data.byteLength > totalCacheCapacity || data.byteLength > maxLargestSize)
		return;

	/* check if the entry is already part of the cache */
	if (path in cacheMap) {
		const entry = cacheMap[path];
		if (entry.mtime >= mtime)
			return;
		CacheDrop(path);
	}

	/* check if space needs to be reserved */
	if (totalCacheSize + data.byteLength > totalCacheCapacity)
		CacheReduce(totalCacheSize + data.byteLength - totalCacheCapacity);

	/* add the entry to the cache */
	libLog.Log(`Added [${path}] to the cache`);
	totalCacheSize += data.byteLength;
	cacheMap[path] = { data: data, mtime: mtime, touched: ++nextTouchStamp };
}
function CacheReduce(capacity: number): void {
	/* create the list of all cached objects sorted by the touched count */
	const paths: string[] = Object.keys(cacheMap).sort((a, b) => cacheMap[a].touched - cacheMap[b].touched);

	/* drop the first half of the entries or more, if the size has not yet been freed */
	for (let i = 0; i < (paths.length + 1) / 2 || capacity > 0; ++i) {
		capacity -= cacheMap[paths[i]].data.byteLength;
		CacheDrop(paths[i]);
	}
}
function CacheDrop(path: string): void {
	if (!(path in cacheMap))
		return;
	libLog.Log(`Dropped [${path}] from the cache`);
	totalCacheSize -= cacheMap[path].data.byteLength;
	delete cacheMap[path];
}

interface CheckState {
	exists: boolean;
	size: number;
	mtime: number;
	data: Buffer | null;
}
function LookupFileState(path: string): CheckState {
	/* read the file size */
	let fileSize: number = 0, mtime: number = 0;
	try {
		if (!libFs.existsSync(path))
			return { exists: false, data: null, size: 0, mtime: 0 };
		const stats = libFs.lstatSync(path);
		if (!stats.isFile())
			return { exists: false, data: null, size: 0, mtime: 0 };
		fileSize = stats.size;
		mtime = stats.mtime.getTime();
	} catch (e: any) {
		libLog.Error(`Filesystem error while checking [${path}]: ${e.message}`);
		throw new Error('File operation failed');
	}

	/* check if the entry is cached */
	if (path in cacheMap) {
		const entry = cacheMap[path];

		/* validate that the entry is still up-to-date and return it */
		if (entry.mtime == mtime && entry.data.length == fileSize) {
			entry.touched = ++nextTouchStamp;
			return { exists: true, data: entry.data, size: fileSize, mtime };
		}

		/* remove the entry as it seems to be outdated */
		CacheDrop(path);
	}
	return { exists: true, data: null, size: fileSize, mtime: mtime };
}

export function Stream(path: string, options?: { start?: number, end?: number, check?: (size: number) => boolean }): libStream.Readable | null {
	/* check if the file exists and if the stream should continue and if the data have already been cached */
	const state = LookupFileState(path);
	if (!state.exists)
		return null;
	if (options?.check != undefined && !options.check(state.size))
		return null;
	if (state.data != null)
		return libStream.Readable.from(state.data.subarray(options?.start, options?.end));

	/* create the data stream */
	let stream: libFs.ReadStream | null = null;
	try {
		stream = libFs.createReadStream(path, { flags: 'r', start: options?.start, end: options?.end });
	} catch (e: any) {
		libLog.Error(`Filesystem error while reading [${path}]: ${e.message}`);
		throw new Error('File operation failed');
	}

	/* check if only a partial file is being read, or it is too large, in which case it will not be added to the cache */
	if (state.size > maxLargestSize || state.size > totalCacheCapacity || (options?.start != undefined && options.start != 0) || (options?.end != undefined && options.end != state.size))
		return stream;

	/* create the transformer stream to cache the data */
	let buffers: Buffer[] = [], failed: boolean = false, totalLength: number = 0;
	const transformer = new libStream.Transform({
		transform(chunk, _, cb) {
			if (failed) return;
			buffers.push(chunk);
			totalLength += chunk.byteLength;
			cb(null, chunk);
		},
		final(cb) {
			if (failed) return;
			if (totalLength == state.size && state.size <= maxLargestSize && state.size <= totalCacheCapacity)
				CacheAdd(path, Buffer.concat(buffers), state.mtime);
			cb(null);
		}
	});

	/* setup the file exceptions to be propagated to the stream */
	let wrapped = stream.pipe(transformer);
	stream.on('error', function (e: Error) {
		libLog.Error(`Filesystem error while reading [${path}]: ${e.message}`);
		failed = true;
		wrapped.destroy(e);
	});
	return stream;
}
export function Read(path: string, options?: { check?: (size: number) => boolean }): Buffer | null {
	/* check if the file exists and if the stream should continue and if the data have already been cached */
	const state = LookupFileState(path);
	if (!state.exists)
		return null;
	if (options?.check != undefined && !options.check(state.size))
		return null;
	if (state.data != null)
		return state.data;

	/* read the data into memory */
	let data: Buffer | null = null;
	try {
		data = libFs.readFileSync(path);
	} catch (e: any) {
		libLog.Error(`Filesystem error while reading [${path}]: ${e.message}`);
		throw new Error('File operation failed');
	}

	/* add the read buffer back to the cache (using the fetched data from before
	*	reading the file - to detect a file-change since before reading the file) */
	if (data.byteLength == state.size && state.size <= maxLargestSize && state.size <= totalCacheCapacity)
		CacheAdd(path, data, state.mtime);
	return data;
}
export function SetCacheOptions(options: { cacheSize?: number, largestFile?: number }): void {
	if (options.cacheSize != undefined && options.cacheSize > 0)
		totalCacheCapacity = options.cacheSize;
	if (options.largestFile != undefined && options.largestFile > 0)
		maxLargestSize = options.largestFile;
	libLog.Info(`Cache capacity set to: ${totalCacheCapacity} with largest objects: ${maxLargestSize}`);

	/* check if the cache needs to be reduced */
	if (totalCacheSize > totalCacheCapacity)
		CacheReduce(totalCacheSize - totalCacheCapacity);
}

/* initialize the default configuration */
export function Initialize(): void {
	SetCacheOptions({ cacheSize: 50_000_000, largestFile: 10_000_000 });
}
