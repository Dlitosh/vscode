/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as parcelWatcher from '@parcel/watcher';
import { existsSync } from 'fs';
import { RunOnceScheduler } from 'vs/base/common/async';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { Emitter } from 'vs/base/common/event';
import { isEqualOrParent } from 'vs/base/common/extpath';
import { parse, ParsedPattern } from 'vs/base/common/glob';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { TernarySearchTree } from 'vs/base/common/map';
import { normalizeNFC } from 'vs/base/common/normalization';
import { dirname, isAbsolute, join, normalize, sep } from 'vs/base/common/path';
import { isLinux, isMacintosh, isWindows } from 'vs/base/common/platform';
import { rtrim } from 'vs/base/common/strings';
import { realcaseSync, realpathSync } from 'vs/base/node/extpath';
import { watchFolder } from 'vs/base/node/watcher';
import { FileChangeType } from 'vs/platform/files/common/files';
import { IWatcherService } from 'vs/platform/files/node/watcher/parcel/watcher';
import { IDiskFileChange, ILogMessage, normalizeFileChanges, IWatchRequest } from 'vs/platform/files/node/watcher/watcher';

export interface IWatcher extends IDisposable {

	/**
	 * The Parcel watcher instance is resolved when the watching has started.
	 */
	readonly instance: Promise<parcelWatcher.AsyncSubscription | undefined>;

	/**
	 * The watch request associated to the watcher.
	 */
	request: IWatchRequest;

	/**
	 * Associated ignored patterns for the watcher that can be updated.
	 */
	ignored: ParsedPattern[];

	/**
	 * How often this watcher has been restarted in case of an unexpected
	 * shutdown.
	 */
	restarts: number;

	/**
	 * The cancellation token associated with the lifecycle of the watcher.
	 */
	token: CancellationToken;

	/**
	 * Stops and disposes the watcher. Same as `dispose` but allows to await
	 * the watcher getting unsubscribed.
	 */
	stop(): Promise<void>;
}

export class ParcelWatcherService extends Disposable implements IWatcherService {

	private static readonly MAX_RESTARTS = 5; // number of restarts we allow before giving up in case of unexpected errors

	private static readonly MAP_PARCEL_WATCHER_ACTION_TO_FILE_CHANGE = new Map<parcelWatcher.EventType, number>(
		[
			['create', FileChangeType.ADDED],
			['update', FileChangeType.UPDATED],
			['delete', FileChangeType.DELETED]
		]
	);

	private static readonly GLOB_MARKERS = {
		Star: '*',
		GlobStar: '**',
		GlobStarPathStartPosix: '**/',
		GlobStarPathEndPosix: '/**',
		StarPathEndPosix: '/*',
		GlobStarPathStartWindows: '**\\',
		GlobStarPathEndWindows: '\\**'
	};

	private static readonly PARCEL_WATCHER_BACKEND = isWindows ? 'windows' : isLinux ? 'inotify' : 'fs-events';

	private readonly _onDidChangeFile = this._register(new Emitter<IDiskFileChange[]>());
	readonly onDidChangeFile = this._onDidChangeFile.event;

	private readonly _onDidLogMessage = this._register(new Emitter<ILogMessage>());
	readonly onDidLogMessage = this._onDidLogMessage.event;

	protected readonly watchers = new Map<string, IWatcher>();

	private verboseLogging = false;
	private enospcErrorLogged = false;

	constructor() {
		super();

		this.registerListeners();
	}

	private registerListeners(): void {

		// Error handling on process
		process.on('uncaughtException', error => this.onUnexpectedError(error));
		process.on('unhandledRejection', error => this.onUnexpectedError(error));
	}

	async watch(requests: IWatchRequest[]): Promise<void> {

		// Figure out duplicates to remove from the requests
		const normalizedRequests = this.normalizeRequests(requests);

		// Gather paths that we should start watching
		const requestsToStartWatching = normalizedRequests.filter(request => {
			const watcher = this.watchers.get(request.path);
			if (!watcher) {
				return true; // not yet watching that path
			}

			// Re-watch path if excludes have changed
			return watcher.request.excludes !== request.excludes;
		});

		// Gather paths that we should stop watching
		const pathsToStopWatching = Array.from(this.watchers.values()).filter(({ request }) => {
			return !normalizedRequests.find(normalizedRequest => normalizedRequest.path === request.path && normalizedRequest.excludes === request.excludes);
		}).map(({ request }) => request.path);

		// Logging
		this.debug(`Request to start watching: ${requestsToStartWatching.map(request => `${request.path} (excludes: ${request.excludes})`).join(',')}`);
		this.debug(`Request to stop watching: ${pathsToStopWatching.join(',')}`);

		// Stop watching as instructed
		for (const pathToStopWatching of pathsToStopWatching) {
			await this.stopWatching(pathToStopWatching);
		}

		// Start watching as instructed
		for (const request of requestsToStartWatching) {
			this.startWatching(request);
		}
	}

	private toExcludePatterns(excludes: string[] | undefined): ParsedPattern[] {
		return Array.isArray(excludes) ? excludes.map(exclude => parse(exclude)) : [];
	}

	protected toExcludePaths(path: string, excludes: string[] | undefined): string[] | undefined {
		if (!Array.isArray(excludes)) {
			return undefined;
		}

		const excludePaths = new Set<string>();

		// Parcel watcher currently does not support glob patterns
		// for native exclusions. As long as that is the case, try
		// to convert exclude patterns into absolute paths that the
		// watcher supports natively to reduce the overhead at the
		// level of the file watcher as much as possible.
		// Refs: https://github.com/parcel-bundler/watcher/issues/64
		for (const exclude of excludes) {
			const isGlob = exclude.includes(ParcelWatcherService.GLOB_MARKERS.Star);

			// Glob pattern: check for typical patterns and convert
			let normalizedExclude: string | undefined = undefined;
			if (isGlob) {

				// Examples: **
				if (exclude === ParcelWatcherService.GLOB_MARKERS.GlobStar) {
					normalizedExclude = path;
				}

				// Examples:
				// - **/node_modules/**
				// - **/.git/objects/**
				// - **/build-folder
				// - output/**
				else {
					const startsWithGlobStar = exclude.startsWith(ParcelWatcherService.GLOB_MARKERS.GlobStarPathStartPosix) || exclude.startsWith(ParcelWatcherService.GLOB_MARKERS.GlobStarPathStartWindows);
					const endsWithGlobStar = exclude.endsWith(ParcelWatcherService.GLOB_MARKERS.GlobStarPathEndPosix) || exclude.endsWith(ParcelWatcherService.GLOB_MARKERS.GlobStarPathEndWindows);
					if (startsWithGlobStar || endsWithGlobStar) {
						if (startsWithGlobStar && endsWithGlobStar) {
							normalizedExclude = exclude.substring(ParcelWatcherService.GLOB_MARKERS.GlobStarPathStartPosix.length, exclude.length - ParcelWatcherService.GLOB_MARKERS.GlobStarPathEndPosix.length);
						} else if (startsWithGlobStar) {
							normalizedExclude = exclude.substring(ParcelWatcherService.GLOB_MARKERS.GlobStarPathStartPosix.length);
						} else {
							normalizedExclude = exclude.substring(0, exclude.length - ParcelWatcherService.GLOB_MARKERS.GlobStarPathEndPosix.length);
						}
					}

					// Support even more glob patterns on Linux where we know
					// that each folder requires a file handle to watch.
					// Examples:
					// - node_modules/* (full form: **/node_modules/*/**)
					if (isLinux && normalizedExclude) {
						const endsWithStar = normalizedExclude?.endsWith(ParcelWatcherService.GLOB_MARKERS.StarPathEndPosix);
						if (endsWithStar) {
							normalizedExclude = normalizedExclude.substring(0, normalizedExclude.length - ParcelWatcherService.GLOB_MARKERS.StarPathEndPosix.length);
						}
					}
				}
			}

			// Not a glob pattern, take as is
			else {
				normalizedExclude = exclude;
			}

			if (!normalizedExclude || normalizedExclude.includes(ParcelWatcherService.GLOB_MARKERS.Star)) {
				continue; // skip for parcel (will be applied later by our glob matching)
			}

			// Absolute path: normalize to watched path and
			// exclude if not a parent of it otherwise.
			if (isAbsolute(normalizedExclude)) {
				if (!isEqualOrParent(normalizedExclude, path, !isLinux)) {
					continue; // exclude points to path outside of watched folder, ignore
				}

				// convert to relative path to ensure we
				// get the correct path casing going forward
				normalizedExclude = normalizedExclude.substr(path.length);
			}

			// Finally take as relative path joined to watched path
			excludePaths.add(rtrim(join(path, normalizedExclude), sep));
		}

		if (excludePaths.size > 0) {
			return Array.from(excludePaths);
		}

		return undefined;
	}

	private startWatching(request: IWatchRequest, restarts = 0): void {
		const cts = new CancellationTokenSource();

		let parcelWatcherPromiseResolve: (watcher: parcelWatcher.AsyncSubscription | undefined) => void;
		const instance = new Promise<parcelWatcher.AsyncSubscription | undefined>(resolve => parcelWatcherPromiseResolve = resolve);

		// Remember as watcher instance
		const watcher: IWatcher = {
			request,
			instance,
			ignored: this.toExcludePatterns(request.excludes),
			restarts,
			token: cts.token,
			stop: async () => {
				cts.dispose(true);
				(await instance)?.unsubscribe();
			},
			dispose: () => {
				watcher.stop();
			}
		};
		this.watchers.set(request.path, watcher);

		// Path checks for symbolic links / wrong casing
		const { realPath, realPathDiffers, realPathLength } = this.normalizePath(request);

		let undeliveredFileEvents: IDiskFileChange[] = [];

		const onRawFileEvent = (path: string, type: FileChangeType) => {
			if (this.verboseLogging) {
				this.log(`${type === FileChangeType.ADDED ? '[ADDED]' : type === FileChangeType.DELETED ? '[DELETED]' : '[CHANGED]'} ${path}`);
			}

			if (!this.isPathIgnored(path, watcher.ignored)) {
				undeliveredFileEvents.push({ type, path });
			} else {
				if (this.verboseLogging) {
					this.log(` >> ignored ${path}`);
				}
			}
		};

		const ignore = this.toExcludePaths(realPath, watcher.request.excludes);
		parcelWatcher.subscribe(realPath, (error, events) => {
			if (watcher.token.isCancellationRequested) {
				return; // return early when disposed
			}

			if (error) {
				this.error(`Unexpected error in event callback: ${toErrorMessage(error)}`, watcher);
			}

			if (events.length === 0) {
				return; // assume this can happen if we had an error before
			}

			for (const event of events) {
				onRawFileEvent(event.path, ParcelWatcherService.MAP_PARCEL_WATCHER_ACTION_TO_FILE_CHANGE.get(event.type)!);
			}

			// Reset undelivered events array
			const undeliveredFileEventsToEmit = undeliveredFileEvents;
			undeliveredFileEvents = [];

			// Normalize and detect root path deletes
			const { events: normalizedEvents, rootDeleted } = this.normalizeEvents(undeliveredFileEventsToEmit, request, realPathDiffers, realPathLength);

			// Broadcast to clients coalesced
			const coalescedEvents = normalizeFileChanges(normalizedEvents);
			this.emitEvents(coalescedEvents);

			// Handle root path delete if confirmed from coalseced events
			if (rootDeleted && coalescedEvents.some(event => event.path === watcher.request.path && event.type === FileChangeType.DELETED)) {
				this.onWatchedPathDeleted(watcher);
			}
		}, {
			backend: ParcelWatcherService.PARCEL_WATCHER_BACKEND,
			ignore
		}).then(parcelWatcher => {
			this.debug(`Started watching: '${realPath}' with backend '${ParcelWatcherService.PARCEL_WATCHER_BACKEND}' and native excludes '${ignore?.join(', ')}'`);

			parcelWatcherPromiseResolve(parcelWatcher);
		}).catch(error => {
			this.onUnexpectedError(error, watcher);

			parcelWatcherPromiseResolve(undefined);
		});
	}

	private emitEvents(events: IDiskFileChange[]): void {

		// Send outside
		this._onDidChangeFile.fire(events);

		// Logging
		if (this.verboseLogging) {
			for (const event of events) {
				this.log(` >> normalized ${event.type === FileChangeType.ADDED ? '[ADDED]' : event.type === FileChangeType.DELETED ? '[DELETED]' : '[CHANGED]'} ${event.path}`);
			}
		}
	}

	private normalizePath(request: IWatchRequest): { realPath: string, realPathDiffers: boolean, realPathLength: number } {
		let realPath = request.path;
		let realPathDiffers = false;
		let realPathLength = request.path.length;

		try {

			// First check for symbolic link
			realPath = realpathSync(request.path);

			// Second check for casing difference
			if (request.path === realPath) {
				realPath = realcaseSync(request.path) ?? request.path;
			}

			// Correct watch path as needed
			if (request.path !== realPath) {
				realPathLength = realPath.length;
				realPathDiffers = true;

				this.warn(`correcting a path to watch that seems to be a symbolic link (original: ${request.path}, real: ${realPath})`);
			}
		} catch (error) {
			// ignore
		}

		return { realPath, realPathDiffers, realPathLength };
	}

	private normalizeEvents(events: IDiskFileChange[], request: IWatchRequest, realPathDiffers: boolean, realPathLength: number): { events: IDiskFileChange[], rootDeleted: boolean } {
		let rootDeleted = false;

		for (const event of events) {

			// Mac uses NFD unicode form on disk, but we want NFC
			if (isMacintosh) {
				event.path = normalizeNFC(event.path);
			}

			// TODO@bpasero workaround for https://github.com/parcel-bundler/watcher/issues/68
			// where watching root drive letter adds extra backslashes.
			if (isWindows) {
				if (request.path.length <= 3) { // for ex. c:, C:\
					event.path = normalize(event.path);
				}
			}

			// Convert paths back to original form in case it differs
			if (realPathDiffers) {
				event.path = request.path + event.path.substr(realPathLength);
			}

			// Check for root deleted
			if (event.path === request.path && event.type === FileChangeType.DELETED) {
				rootDeleted = true;
			}
		}

		return { events, rootDeleted };
	}

	private onWatchedPathDeleted(watcher: IWatcher): void {
		this.warn('Watcher shutdown because watched path got deleted', watcher);

		const parentPath = dirname(watcher.request.path);
		if (existsSync(parentPath)) {
			const disposable = watchFolder(parentPath, (type, path) => {
				if (watcher.token.isCancellationRequested) {
					return; // return early when disposed
				}

				// Watcher path came back! Restart watching...
				if (path === watcher.request.path && (type === 'added' || type === 'changed')) {
					this.warn('Watcher restarts because watched path got created again', watcher);

					// Stop watching that parent folder
					disposable.dispose();

					// Send a manual event given we know the root got added again
					this.emitEvents([{ path: watcher.request.path, type: FileChangeType.ADDED }]);

					// Restart the file watching
					this.restartWatching(watcher);
				}
			}, error => {
				// Ignore
			});

			// Make sure to stop watching when the watcher is disposed
			watcher.token.onCancellationRequested(() => disposable.dispose());
		}
	}

	private onUnexpectedError(error: unknown, watcher?: IWatcher): void {
		const msg = toErrorMessage(error);

		// Specially handle ENOSPC errors that can happen when
		// the watcher consumes so many file descriptors that
		// we are running into a limit. We only want to warn
		// once in this case to avoid log spam.
		// See https://github.com/microsoft/vscode/issues/7950
		if (msg.indexOf('No space left on device') !== -1) {
			if (!this.enospcErrorLogged) {
				this.error('Inotify limit reached (ENOSPC)', watcher);

				this.enospcErrorLogged = true;
			}
		}

		// Any other error is unexpected and we should try to
		// restart the watcher as a result to get into healthy
		// state again if possible and if not attempted too much
		else {
			if (watcher && watcher.restarts < ParcelWatcherService.MAX_RESTARTS) {
				if (existsSync(watcher.request.path)) {
					this.warn(`Watcher will be restarted due to unexpected error: ${error}`, watcher);

					this.restartWatching(watcher);
				} else {
					this.error(`Unexpected error: ${msg} (EUNKNOWN: path ${watcher.request.path} no longer exists)`, watcher);
				}
			} else {
				this.error(`Unexpected error: ${msg} (EUNKNOWN)`, watcher);
			}
		}
	}

	async stop(): Promise<void> {
		for (const [path] of this.watchers) {
			await this.stopWatching(path);
		}

		this.watchers.clear();
	}

	protected restartWatching(watcher: IWatcher, delay = 800): void {

		// Restart watcher delayed to accomodate for
		// changes on disk that have triggered the
		// need for a restart in the first place.
		const scheduler = new RunOnceScheduler(async () => {
			if (watcher.token.isCancellationRequested) {
				return; // return early when disposed
			}

			// Await the watcher having stopped, as this is
			// needed to properly re-watch the same path
			await this.stopWatching(watcher.request.path);

			// Start watcher again counting the restarts
			this.startWatching(watcher.request, watcher.restarts + 1);
		}, delay);

		scheduler.schedule();
		watcher.token.onCancellationRequested(() => scheduler.dispose());
	}

	private async stopWatching(path: string): Promise<void> {
		const watcher = this.watchers.get(path);
		if (watcher) {
			this.watchers.delete(path);

			await watcher.stop();
		}
	}

	protected normalizeRequests(requests: IWatchRequest[]): IWatchRequest[] {
		const requestTrie = TernarySearchTree.forPaths<IWatchRequest>();

		// Sort requests by path length to have shortest first
		// to have a way to prevent children to be watched if
		// parents exist.
		requests.sort((requestA, requestB) => requestA.path.length - requestB.path.length);

		// Only consider requests for watching that are not
		// a child of an existing request path to prevent
		// duplication.
		//
		// However, allow explicit requests to watch folders
		// that are symbolic links because the Parcel watcher
		// does not allow to recursively watch symbolic links.
		for (const request of requests) {
			if (requestTrie.findSubstr(request.path)) {
				try {
					const realpath = realpathSync(request.path);
					if (realpath === request.path) {
						this.warn(`ignoring a path for watching who's parent is already watched: ${request.path}`);

						continue; // path is not a symbolic link or similar
					}
				} catch (error) {
					continue; // invalid path - ignore from watching
				}
			}

			requestTrie.set(request.path, request);
		}

		return Array.from(requestTrie).map(([, request]) => request);
	}

	private isPathIgnored(absolutePath: string, ignored: ParsedPattern[]): boolean {
		return ignored.some(ignore => ignore(absolutePath));
	}

	async setVerboseLogging(enabled: boolean): Promise<void> {
		this.verboseLogging = enabled;
	}

	private log(message: string) {
		this._onDidLogMessage.fire({ type: 'trace', message: this.toMessage(message) });
	}

	private warn(message: string, watcher?: IWatcher) {
		this._onDidLogMessage.fire({ type: 'warn', message: this.toMessage(message, watcher) });
	}

	private error(message: string, watcher: IWatcher | undefined) {
		this._onDidLogMessage.fire({ type: 'error', message: this.toMessage(message, watcher) });
	}

	private debug(message: string): void {
		this._onDidLogMessage.fire({ type: 'debug', message: this.toMessage(message) });
	}

	private toMessage(message: string, watcher?: IWatcher): string {
		return watcher ? `[File Watcher (parcel)] ${message} (path: ${watcher.request.path})` : `[File Watcher (parcel)] ${message}`;
	}
}
