/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */
import * as libLog from "./log.js";
import * as libBuilder from "./builder.js";
import * as libClient from "./client.js";
import * as libFs from "fs";
import * as libStream from "stream";

interface CacheEntry {
	data: Buffer;
	mtime: number;
	touched: number;
	persistent: boolean;
}
const cacheMap: Record<string, CacheEntry> = {};
let nextTouchStamp: number = 0, totalCacheSize: number = 0, totalCacheCapacity: number = 0, maxLargestSize: number = 0;

function CacheAdd(path: string, data: Buffer, mtime: number, persistent: boolean): void {
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
	cacheMap[path] = { data: data, mtime: mtime, touched: ++nextTouchStamp, persistent };
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

export class Cached {
	private path: string;
	private size: number;
	private data: Buffer | null;
	private mtime: number;
	private persistent: boolean;

	private constructor(path: string, size: number, data: Buffer | null, mtime: number, persistent: boolean) {
		this.path = path;
		this.size = size;
		this.data = data;
		this.mtime = mtime;
		this.persistent = persistent;
	}
	private makeStream(options?: { start?: number, end?: number }): libStream.Readable {
		/* check if the data have already been cached */
		if (this.data != null)
			return libStream.Readable.from(this.data.subarray(options?.start, (options?.end == undefined ? undefined : options.end + 1)));

		/* create the data stream */
		let stream: libFs.ReadStream | null = null;
		try {
			stream = libFs.createReadStream(this.path, { flags: 'r', start: options?.start, end: options?.end });
		} catch (e: any) {
			libLog.Error(`Filesystem error while streaming [${this.path}]: ${e.message}`);
			throw new Error('File operation failed');
		}

		/* check if only a partial file is being read, or it is too large, in which case it will not be added to the cache */
		if (this.size > maxLargestSize || this.size > totalCacheCapacity || (options?.start != undefined && options.start != 0) || (options?.end != undefined && options.end + 1 != this.size))
			return stream;

		/* create the transformer stream to cache the data */
		let buffers: Buffer[] = [], failed: boolean = false, totalLength: number = 0;
		const transformer = new libStream.Transform({
			transform: (chunk, _, cb) => {
				if (failed) return;
				totalLength += chunk.byteLength;
				buffers.push(chunk);
				cb(null, chunk);
			},
			final: (cb) => {
				if (failed) return;
				if (totalLength == this.size && this.size <= maxLargestSize && this.size <= totalCacheCapacity)
					CacheAdd(this.path, Buffer.concat(buffers), this.mtime, this.persistent);
				cb(null);
			}
		});

		/* setup the file exceptions to be propagated to the stream */
		let wrapped = stream.pipe(transformer);
		stream.on('error', (e: Error) => {
			libLog.Error(`Filesystem error while streaming [${this.path}]: ${e.message}`);
			failed = true;
			wrapped.destroy(new Error('File operation failed'));
		});
		return wrapped;
	}
	private static checkStats(path: string): [number | null, number] {
		/* check if the file exists and read its file-size and mtime */
		try {
			/* check if the file exists and is a file */
			if (!libFs.existsSync(path))
				return [null, 0];
			const stats = libFs.lstatSync(path);
			if (!stats.isFile())
				return [null, 0];

			/* extract the file size and modified time */
			return [stats.size, stats.mtime.getTime()];
		} catch (e: any) {
			libLog.Error(`Filesystem error while checking [${path}]: ${e.message}`);
			throw new Error('File operation failed');
		}
	}

	/* [persistent]: if cached, dont check if the underlying file has changed since caching */
	static make(path: string, options?: { persistent?: boolean }): Cached | null {
		/* check if the entry is marked as persistent and already in the cache, in which case the file doesn't even need to be checked */
		if (options?.persistent === true && cacheMap[path]?.persistent === true) {
			const entry = cacheMap[path];
			entry.touched = ++nextTouchStamp;
			return new Cached(path, entry.data.byteLength, entry.data, entry.mtime, entry.persistent);
		}

		/* check if the file exists and read its stats */
		const [fileSize, mtime] = Cached.checkStats(path);
		if (fileSize == null)
			return null;

		/* check if the entry is cached */
		if (path in cacheMap) {
			const entry = cacheMap[path];

			/* validate that the entry is still up-to-date and return it */
			if (entry.mtime == mtime && entry.data.length == fileSize) {
				entry.touched = ++nextTouchStamp;
				return new Cached(path, fileSize, entry.data, mtime, options?.persistent || false);
			}

			/* remove the entry as it seems to be outdated */
			CacheDrop(path);
		}
		return new Cached(path, fileSize, null, mtime, options?.persistent || false);
	}

	public fileSize(): number {
		return this.size;
	}

	/* object must not be used anymore after reading or streaming from it (on errors, logs them and throws exception) */
	public stream(options?: { start?: number, end?: number }): libStream.Readable {
		return this.makeStream(options);
	}

	/* object must not be used anymore after reading or streaming from it (on errors, logs them and throws exception) */
	public readSync(): Buffer {
		/* check if the data have already been cached */
		if (this.data != null)
			return this.data;

		/* read the data into memory */
		try {
			this.data = libFs.readFileSync(this.path);
		} catch (e: any) {
			libLog.Error(`Filesystem error while reading [${this.path}]: ${e.message}`);
			throw new Error('File operation failed');
		}

		/* check if the file-size changed mid operation */
		if (this.data.byteLength != this.size) {
			libLog.Error(`File size changed mid operation [${this.path}]: [${this.data.byteLength}] != [${this.size}]`);
			throw new Error('File operation failed');
		}

		/* add the read buffer back to the cache (using the fetched data from before
		*	reading the file - to detect a file-change since before reading the file) */
		if (this.size <= maxLargestSize && this.size <= totalCacheCapacity)
			CacheAdd(this.path, this.data, this.mtime, this.persistent);
		return this.data;
	}

	/* object must not be used anymore after reading or streaming from it (on errors, logs them and throws exception) */
	public async readAsync(): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const stream: libStream.Readable = this.makeStream();
			const buffers: Buffer[] = [];
			let failed: boolean = false;

			/* register the handler to collect the data and stream them out */
			stream.on("data", (chunk) => {
				if (!failed)
					buffers.push(chunk);
			});
			stream.on("error", (err) => {
				if (!failed) {
					failed = true;
					reject(err);
				}
			});
			stream.on("end", () => {
				if (!failed) {
					failed = true;
					resolve(Buffer.concat(buffers));
				}
			});
		});
	}
};

export function Get(path: string, options?: { persistent?: boolean }): Cached | null {
	return Cached.make(path, options);
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
