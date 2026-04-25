/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */
import { Config as libConfig } from "./config.js";
import * as libLog from "./log.js";
import * as libFs from "fs";
import * as libStream from "stream";

const logger = libLog.Logger('cache');

interface CacheEntry {
	data: Buffer;
	mtime: number;
	touched: number;
	persistent: boolean;
}
class CacheManager {
	private cacheMap: Record<string, CacheEntry> = {};
	private nextStamp: number = 0;
	private allocated: number = 0;
	private totalCapacity: number = 0;
	private largestSize: number = 0;

	public constructor() {
		this.totalCapacity = libConfig.cacheSize;
		this.largestSize = libConfig.cacheFileSizeLimit;
		libConfig.subscribe(() => this.applyConfig());
	}

	private applyConfig(): void {
		this.totalCapacity = Math.max(libConfig.cacheSize, 0);
		this.largestSize = Math.max(libConfig.cacheFileSizeLimit, 0);

		/* check if the cache needs to be reduced */
		if (this.allocated > this.totalCapacity)
			this.reduce(this.allocated - this.totalCapacity);
	}
	private reduce(capacity: number): void {
		/* create the list of all cached objects sorted by the touched count */
		const paths: string[] = Object.keys(this.cacheMap).sort((a, b) => this.cacheMap[a].touched - this.cacheMap[b].touched);

		/* drop the first half of the entries or more, if the size has not yet been freed (valid as callers
		*	guarantee capacity <= allocated, thus the capacity will reach <= 0 before i overflows the paths) */
		for (let i = 0; i < (paths.length + 1) / 2 || capacity > 0; ++i) {
			capacity -= this.cacheMap[paths[i]].data.byteLength;
			this.drop(paths[i]);
		}
	}

	public add(path: string, data: Buffer, mtime: number, persistent: boolean): void {
		if (!this.cacheable(data.byteLength))
			return;

		/* check if the entry is already part of the cache */
		if (path in this.cacheMap) {
			const entry = this.cacheMap[path];
			if (entry.mtime >= mtime)
				return;
			this.drop(path);
		}

		/* check if space needs to be reserved */
		if (this.allocated + data.byteLength > this.totalCapacity)
			this.reduce(this.allocated + data.byteLength - this.totalCapacity);

		/* add the entry to the cache */
		logger.log(`Added [${path}] to the cache`);
		this.allocated += data.byteLength;
		this.cacheMap[path] = { data: data, mtime: mtime, touched: ++this.nextStamp, persistent };
	}
	public drop(path: string): void {
		if (!(path in this.cacheMap))
			return;
		logger.log(`Dropped [${path}] from the cache`);
		this.allocated -= this.cacheMap[path].data.byteLength;
		delete this.cacheMap[path];
	}
	public cacheable(size: number): boolean {
		return (size <= this.largestSize && size <= this.totalCapacity);
	}
	public findPersistent(path: string): CacheEntry | null {
		const entry = this.cacheMap[path] ?? null;
		if (entry == null)
			return null;

		if (entry.persistent) {
			entry.touched = ++this.nextStamp;
			return entry;
		}
		return null;
	}
	public find(path: string, mtime: number, size: number): CacheEntry | null {
		const entry = this.cacheMap[path] ?? null;
		if (entry == null)
			return null;

		/* validate that the entry is still up-to-date and return it */
		if (entry.mtime == mtime && entry.data.length == size) {
			entry.touched = ++this.nextStamp;
			return entry;
		}

		/* remove the entry as it seems to be outdated */
		this.drop(path);
		return null;
	}
}
const cacheManager: CacheManager = new CacheManager();


export class Cached {
	private path: string;
	private size: number;
	private data: Buffer | null;
	private mtime: number;
	private persistent: boolean;

	public constructor(path: string, size: number, data: Buffer | null, mtime: number, persistent: boolean) {
		this.path = path;
		this.size = size;
		this.data = data;
		this.mtime = mtime;
		this.persistent = persistent;
	}
	private makeStream(options?: { start?: number, end?: number }): libStream.Readable {
		/* check if the data have already been cached */
		if (this.data != null)
			return libStream.Readable.from(this.data.subarray(options?.start, (options?.end == null ? undefined : options.end + 1)));

		/* create the data stream */
		let stream: libFs.ReadStream | null = null;
		try {
			stream = libFs.createReadStream(this.path, { flags: 'r', start: options?.start, end: options?.end });
		} catch (err: any) {
			logger.error(`Filesystem error while streaming [${this.path}]: ${err.message}`);
			throw new Error('File operation failed');
		}

		/* check if only a partial file is being read, or it is too large, in which case it will not be added to the cache */
		if (!cacheManager.cacheable(this.size) || (options?.start != null && options.start != 0) || (options?.end != null && options.end + 1 != this.size))
			return stream;

		/* create the transformer stream to cache the data */
		let buffers: Buffer[] = [], settled: boolean = false, totalLength: number = 0;
		const transformer = new libStream.Transform({
			transform: (chunk, _, cb) => {
				if (settled) return cb(new Error('Reading already completed'));
				totalLength += chunk.byteLength;
				buffers.push(chunk);
				cb(null, chunk);
			},
			final: (cb) => {
				if (settled) return cb(new Error('Reading already completed'));
				if (totalLength == this.size && cacheManager.cacheable(this.size))
					cacheManager.add(this.path, Buffer.concat(buffers), this.mtime, this.persistent);
				cb(null);
			}
		});

		/* setup the file exceptions to be propagated to the stream */
		let wrapped = stream.pipe(transformer);
		stream.on('error', (err: any) => {
			if (settled) return; settled = true;
			wrapped.destroy(err);
		});
		wrapped.on('error', (err: any) => {
			if (settled) return; settled = true;
			stream.destroy(err);
		});
		return wrapped;
	}

	/* size in bytes of the file */
	public fileSize(): number {
		return this.size;
	}

	/* fetch the last modified time formatted for the network */
	public lastModified(): string {
		return new Date(this.mtime).toUTCString();
	}

	/* fetch the unique-id to identify this version of the cached file (constructed,
	*	just like the cache identifies them as equivalent: size+last-modified) */
	public uniqueId(): string {
		return `${this.mtime}-${this.size}`;
	}

	/* current path of the cache object */
	public getPath(): string {
		return this.path;
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
		} catch (err: any) {
			logger.error(`Filesystem error while reading [${this.path}]: ${err.message}`);
			throw new Error('File operation failed');
		}

		/* check if the file-size changed mid operation */
		if (this.data.byteLength != this.size) {
			logger.error(`File size changed mid operation [${this.path}]: [${this.data.byteLength}] != [${this.size}]`);
			throw new Error('File operation failed');
		}

		/* add the read buffer back to the cache (using the fetched data from before
		*	reading the file - to detect a file-change since before reading the file) */
		cacheManager.add(this.path, this.data, this.mtime, this.persistent);
		return this.data;
	}

	/* object must not be used anymore after reading or streaming from it (on errors, logs them and throws exception) */
	public async readAsync(): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const stream: libStream.Readable = this.makeStream();
			const buffers: Buffer[] = [];
			let settled: boolean = false;

			/* register the handler to collect the data and stream them out */
			stream.on("data", (chunk) => {
				if (!settled)
					buffers.push(chunk);
			});
			stream.on("error", (err) => {
				if (!settled) {
					settled = true;
					reject(err);
				}
			});
			stream.on("end", () => {
				if (!settled) {
					settled = true;
					resolve(Buffer.concat(buffers));
				}
			});
		});
	}
}

/* [persistent]: if cached as persistent, dont check if the underlying file has changed since caching */
export function Get(path: string, options?: { persistent?: boolean }): Cached | null {
	/* check if the entry is marked as persistent and already in the
	*	cache, in which case the file doesn't even need to be checked */
	let entry = (options?.persistent === true ? cacheManager.findPersistent(path) : null);
	if (entry != null)
		return new Cached(path, entry.data.byteLength, entry.data, entry.mtime, entry.persistent);

	/* check if the file exists and read its file-size and mtime */
	let fileSize = 0, mtime = 0;
	try {
		if (!libFs.existsSync(path))
			return null;
		const stats = libFs.lstatSync(path);
		if (!stats.isFile())
			return null;
		fileSize = stats.size, mtime = stats.mtime.getTime();
	} catch (err: any) {
		logger.error(`Filesystem error while checking [${path}]: ${err.message}`);
		throw new Error('File operation failed');
	}

	/* check if the path exists as non-persistent in the cache and otherwise return the uncached entry */
	entry = cacheManager.find(path, mtime, fileSize);
	if (entry != null)
		return new Cached(path, fileSize, entry.data, mtime, options?.persistent ?? false);
	return new Cached(path, fileSize, null, mtime, options?.persistent ?? false);
}
