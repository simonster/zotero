/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2009 Center for History and New Media
                     George Mason University, Fairfax, Virginia, USA
                     http://zotero.org
    
    This file is part of Zotero.
    
    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
    
    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.
    
    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/


Zotero.Sync.Storage.ZFS = (function () {
	var _rootURI;
	var _userURI;
	var _cachedCredentials = false;
	var _lastSyncTime = null;
	
	/**
	 * Get file metadata on storage server
	 *
	 * @param	{Zotero.Item}	item
	 * @param	{Function}		callback		Callback f(item, etag)
	 */
	function getStorageFileInfo(item, callback) {
		var uri = getItemInfoURI(item);
		
		Zotero.HTTP.doGet(uri, function (req) {
			var funcName = "Zotero.Sync.Storage.ZFS.getStorageFileInfo()";
			
			if (req.status == 404) {
				callback(item, false);
				return;
			}
			else if (req.status != 200) {
				var msg = "Unexpected status code " + req.status + " in " + funcName
							+ " (" + Zotero.Items.getLibraryKeyHash(item) + ")";
				Zotero.debug(msg, 1);
				Zotero.debug(req.responseText);
				Components.utils.reportError(msg);
				Zotero.Sync.Storage.EventManager.error(Zotero.Sync.Storage.defaultError);
			}
			
			var info = {};
			info.hash = req.getResponseHeader('ETag');
			if (!info.hash) {
				var msg = "Hash not found in info response in " + funcName
							+ " (" + Zotero.Items.getLibraryKeyHash(item) + ")";
				Zotero.debug(msg, 1);
				Zotero.debug(req.responseText);
				Components.utils.reportError(msg);
				try {
					Zotero.debug(req.getAllResponseHeaders());
				}
				catch (e) {
					Zotero.debug("Response headers unavailable");
				}
				// TODO: localize?
				var msg = "A file sync error occurred. Please restart " + Zotero.appName + " and/or your computer and try syncing again.\n\n"
					+ "If the error persists, there may be a problem with either your computer or your network: security software, proxy server, VPN, etc. "
					+ "Try disabling any security/firewall software you're using or, if this is a laptop, try from a different network.";
				Zotero.Sync.Storage.EventManager.error(msg);
			}
			info.filename = req.getResponseHeader('X-Zotero-Filename');
			var mtime = req.getResponseHeader('X-Zotero-Modification-Time');
			info.mtime = parseInt(mtime);
			info.compressed = req.getResponseHeader('X-Zotero-Compressed') == 'Yes';
			Zotero.debug(info);
			
			callback(item, info);
		});
	}
	
	
	/**
	 * Upload the file to the server
	 *
	 * @param	{Object}		Object with 'request' property
	 * @return	{void}
	 */
	function processUploadFile(data) {
		/*
		updateSizeMultiplier(
			(100 - Zotero.Sync.Storage.compressionTracker.ratio) / 100
		);
		*/
		
		var request = data.request;
		var item = Zotero.Sync.Storage.getItemFromRequestName(request.name);
		getStorageFileInfo(item, function (item, info) {
			if (request.isFinished()) {
				Zotero.debug("Upload request '" + request.name
					+ "' is no longer running after getting file info");
				return;
			}
			
			try {
				// Check for conflict
				if (Zotero.Sync.Storage.getSyncState(item.id)
						!= Zotero.Sync.Storage.SYNC_STATE_FORCE_UPLOAD) {
					if (info) {
						// Remote mod time
						var mtime = info.mtime;
						// Local file time
						var fmtime = item.attachmentModificationTime;
						
						var same = false;
						var useLocal = false;
						if (fmtime == mtime) {
							same = true;
							Zotero.debug("File mod time matches remote file -- skipping upload");
						}
						// Allow floored timestamps for filesystems that don't support
						// millisecond precision (e.g., HFS+)
						else if (Math.floor(mtime / 1000) * 1000 == fmtime || Math.floor(fmtime / 1000) * 1000 == mtime) {
							same = true;
							Zotero.debug("File mod times are within one-second precision (" + fmtime + " ≅ " + mtime + ") "
								+ "-- skipping upload");
						}
						// Allow timestamp to be exactly one hour off to get around
						// time zone issues -- there may be a proper way to fix this
						else if (Math.abs(fmtime - mtime) == 3600000
								// And check with one-second precision as well
								|| Math.abs(fmtime - Math.floor(mtime / 1000) * 1000) == 3600000
								|| Math.abs(Math.floor(fmtime / 1000) * 1000 - mtime) == 3600000) {
							same = true;
							Zotero.debug("File mod time (" + fmtime + ") is exactly one hour off remote file (" + mtime + ") "
								+ "-- assuming time zone issue and skipping upload");
						}
						// Ignore maxed-out 32-bit ints, from brief problem after switch to 32-bit servers
						else if (mtime == 2147483647) {
							Zotero.debug("Remote mod time is invalid -- uploading local file version");
							useLocal = true;
						}
						
						if (same) {
							Zotero.debug(Zotero.Sync.Storage.getSyncedModificationTime(item.id));
							
							Zotero.DB.beginTransaction();
							var syncState = Zotero.Sync.Storage.getSyncState(item.id);
							//Zotero.Sync.Storage.setSyncedModificationTime(item.id, fmtime, true);
							Zotero.Sync.Storage.setSyncedModificationTime(item.id, fmtime);
							Zotero.Sync.Storage.setSyncState(item.id, Zotero.Sync.Storage.SYNC_STATE_IN_SYNC);
							Zotero.DB.commitTransaction();
							Zotero.Sync.Storage.EventManager.changesMade();
							request.finish();
							return;
						}
						
						var smtime = Zotero.Sync.Storage.getSyncedModificationTime(item.id);
						if (!useLocal && smtime != mtime) {
							var localData = { modTime: fmtime };
							var remoteData = { modTime: mtime };
							Zotero.Sync.Storage.QueueManager.addConflict(
								request.name, localData, remoteData
							);
							Zotero.debug("Conflict -- last synced file mod time "
								+ "does not match time on storage server"
								+ " (" + smtime + " != " + mtime + ")");
							request.finish();
							return;
						}
					}
					else {
						Zotero.debug("Remote file not found for item " + item.libraryID + "/" + item.key);
					}
				}
				
				getFileUploadParameters(
					item,
					function (item, target, uploadKey, params) {
						try {
							postFile(request, item, target, uploadKey, params);
						}
						catch (e) {
							Zotero.Sync.Storage.EventManager.error(e);
						}
					},
					function () {
						updateItemFileInfo(item);
						request.finish();
					}
				);
			}
			catch (e) {
				Zotero.Sync.Storage.EventManager.error(e);
			}
		});
	}
	
	
	/**
	 * Get mod time of file on storage server
	 *
	 * @param	{Zotero.Item}					item
	 * @param	{Function}		uploadCallback					Callback f(request, item, target, params)
	 * @param	{Function}		existsCallback					Callback f() to call when file already exists
	 *																on server and uploading isn't necessary
	 */
	function getFileUploadParameters(item, uploadCallback, existsCallback) {
		var uri = getItemURI(item);
		
		if (Zotero.Attachments.getNumFiles(item) > 1) {
			var file = Zotero.getTempDirectory();
			var filename = item.key + '.zip';
			file.append(filename);
			uri.spec = uri.spec;
			var zip = true;
		}
		else {
			var file = item.getFile();
			var filename = file.leafName;
			var zip = false;
		}
		
		var mtime = item.attachmentModificationTime;
		var hash = Zotero.Utilities.Internal.md5(file);
		
		var body = "md5=" + hash + "&filename=" + encodeURIComponent(filename)
					+ "&filesize=" + file.fileSize + "&mtime=" + mtime;
		if (zip) {
			body += "&zip=1";
		}
		
		Zotero.HTTP.doPost(uri, body, function (req) {
			var funcName = "Zotero.Sync.Storage.ZFS.getFileUploadParameters()";
			
			if (req.status == 413) {
				var retry = req.getResponseHeader('Retry-After');
				if (retry) {
					var minutes = Math.round(retry / 60);
					// TODO: localize
					var e = new Zotero.Error(
						"You have too many queued uploads. "
							+ "Please try again in " + minutes + " minutes.",
						"ZFS_UPLOAD_QUEUE_LIMIT"
					);
					Zotero.Sync.Storage.EventManager.error(e);
				}
				
				var text, buttonText = null, buttonCallback;
				
				// Group file
				if (item.libraryID) {
					var group = Zotero.Groups.getByLibraryID(item.libraryID);
					text = Zotero.getString('sync.storage.error.zfs.groupQuotaReached1', group.name) + "\n\n"
							+ Zotero.getString('sync.storage.error.zfs.groupQuotaReached2');
				}
				// Personal file
				else {
					text = Zotero.getString('sync.storage.error.zfs.personalQuotaReached1') + "\n\n"
							+ Zotero.getString('sync.storage.error.zfs.personalQuotaReached2');
					buttonText = Zotero.getString('sync.storage.openAccountSettings');
					buttonCallback = function () {
						var url = "https://www.zotero.org/settings/storage";
						
						var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
									.getService(Components.interfaces.nsIWindowMediator);
						var win = wm.getMostRecentWindow("navigator:browser");
						var browser = win.getBrowser();
						browser.selectedTab = browser.addTab(url);
					}
				}
				
				// TODO: localize
				text += "\n\n" + filename + " (" + Math.round(file.fileSize / 1024) + "KB)";
				
				Zotero.debug(req.responseText);
				
				var e = new Zotero.Error(
					"The file '" + filename + "' would exceed your Zotero File Storage quota",
					"ZFS_OVER_QUOTA",
					{
						dialogText: text,
						dialogButtonText: buttonText,
						dialogButtonCallback: buttonCallback
					}
				);
				Zotero.debug(e, 2);
				Components.utils.reportError(e);
				// Stop uploads, log warning, and continue
				Zotero.Sync.Storage.QueueManager.get('upload').stop();
				Zotero.Sync.Storage.EventManager.warning(e);
				Zotero.Sync.Storage.EventManager.success();
				return;
			}
			else if (req.status == 403) {
				Zotero.debug(req.responseText);
				
				var groupID = Zotero.Groups.getGroupIDFromLibraryID(item.libraryID);
				var e = new Zotero.Error(
					"File editing denied for group",
					"ZFS_FILE_EDITING_DENIED",
					{
						groupID: groupID
					}
				);
				Zotero.Sync.Storage.EventManager.error(e);
			}
			else if (req.status == 404) {
				Components.utils.reportError("Unexpected status code 404 in " + funcName
							 + " (" + Zotero.Items.getLibraryKeyHash(item) + ")");
				if (Zotero.Prefs.get('sync.debugNoAutoResetClient')) {
					Components.utils.reportError("Skipping automatic client reset due to debug pref");
					return;
				}
				if (!Zotero.Sync.Server.canAutoResetClient) {
					Components.utils.reportError("Client has already been auto-reset -- manual sync required");
					return;
				}
				Zotero.Sync.Server.resetClient();
				Zotero.Sync.Server.canAutoResetClient = false;
				Zotero.Sync.Storage.EventManager.error(Zotero.Sync.Storage.defaultError);
			}
			else if (req.status != 200) {
				var msg = "Unexpected status code " + req.status + " in " + funcName
							 + " (" + Zotero.Items.getLibraryKeyHash(item) + ")";
				Zotero.debug(msg, 1);
				Zotero.debug(req.responseText);
				Zotero.debug(req.getAllResponseHeaders());
				Components.utils.reportError(msg);
				Zotero.Sync.Storage.EventManager.error(Zotero.Sync.Storage.defaultError);
			}
			
			Zotero.debug(req.responseText);
			
			try {
				// Strip XML declaration and convert to E4X
				var xml = new XML(Zotero.Utilities.trim(req.responseText.replace(/<\?xml.*\?>/, '')));
			}
			catch (e) {
				Zotero.Sync.Storage.EventManager.error(
					"Invalid response retrieving file upload parameters"
				);
			}
			
			if (xml.name() != 'upload' && xml.name() != 'exists') {
				Zotero.Sync.Storage.EventManager.error(
					"Invalid response retrieving file upload parameters"
				);
			}
			// File was already available, so uploading isn't required
			if (xml.name() == 'exists') {
				existsCallback();
				return;
			}
			
			var url = xml.url.toString();
			var uploadKey = xml.key.toString();
			var params = {}, p = '';
			for each(var param in xml.params.children()) {
				params[param.name()] = param.toString();
			}
			Zotero.debug(params);
			uploadCallback(item, url, uploadKey, params);
		});
	}
	
	
	function postFile(request, item, url, uploadKey, params) {
		if (request.isFinished()) {
			Zotero.debug("Upload request " + request.name + " is no longer running after getting upload parameters");
			return;
		}
		
		var file = getUploadFile(item);
		
		// TODO: make sure this doesn't appear in file
		var boundary = "---------------------------" + Math.random().toString().substr(2);
		
		var mis = Components.classes["@mozilla.org/io/multiplex-input-stream;1"]
					.createInstance(Components.interfaces.nsIMultiplexInputStream);
		
		// Add parameters
		for (var key in params) {
			var storage = Components.classes["@mozilla.org/storagestream;1"]
							.createInstance(Components.interfaces.nsIStorageStream);
			storage.init(4096, 4294967295, null); // PR_UINT32_MAX
			var out = storage.getOutputStream(0);
			
			var conv = Components.classes["@mozilla.org/intl/converter-output-stream;1"]
							.createInstance(Components.interfaces.nsIConverterOutputStream);
			conv.init(out, null, 4096, "?");
			
			var str = "--" + boundary + '\r\nContent-Disposition: form-data; name="' + key + '"'
						+ '\r\n\r\n' + params[key] + '\r\n';
			conv.writeString(str);
			conv.close();
			
			var instr = storage.newInputStream(0);
			mis.appendStream(instr);
		}
		
		// Add file
		var sis = Components.classes["@mozilla.org/io/string-input-stream;1"]
					.createInstance(Components.interfaces.nsIStringInputStream);
		var str = "--" + boundary + '\r\nContent-Disposition: form-data; name="file"\r\n\r\n';
		sis.setData(str, -1);
		mis.appendStream(sis);
		
		var fis = Components.classes["@mozilla.org/network/file-input-stream;1"]
					.createInstance(Components.interfaces.nsIFileInputStream);
		fis.init(file, 0x01, 0, Components.interfaces.nsIFileInputStream.CLOSE_ON_EOF);
		
		var bis = Components.classes["@mozilla.org/network/buffered-input-stream;1"]
					.createInstance(Components.interfaces.nsIBufferedInputStream)
		bis.init(fis, 64 * 1024);
		mis.appendStream(bis);
		
		// End request
		var sis = Components.classes["@mozilla.org/io/string-input-stream;1"]
					.createInstance(Components.interfaces.nsIStringInputStream);
		var str = "\r\n--" + boundary + "--";
		sis.setData(str, -1);
		mis.appendStream(sis);
		
		
	/*	var cstream = Components.classes["@mozilla.org/intl/converter-input-stream;1"].
		createInstance(Components.interfaces.nsIConverterInputStream);
		cstream.init(mis, "UTF-8", 0, 0); // you can use another encoding here if you wish
		
		let (str = {}) {
			cstream.readString(-1, str); // read the whole file and put it in str.value
			data = str.value;
		}
		cstream.close(); // this closes fstream
		alert(data);
	*/	
		
		var ios = Components.classes["@mozilla.org/network/io-service;1"].
					getService(Components.interfaces.nsIIOService);
		var uri = ios.newURI(url, null, null);
		var channel = ios.newChannelFromURI(uri);
		
		channel.QueryInterface(Components.interfaces.nsIUploadChannel);
		channel.setUploadStream(mis, "multipart/form-data", -1);
		channel.QueryInterface(Components.interfaces.nsIHttpChannel);
		channel.requestMethod = 'POST';
		channel.allowPipelining = false;
		channel.setRequestHeader('Keep-Alive', '', false);
		channel.setRequestHeader('Connection', '', false);
		channel.setRequestHeader("Content-Type", "multipart/form-data; boundary=" + boundary, false);
		//channel.setRequestHeader('Date', date, false);
		
		request.setChannel(channel);
		
		var listener = new Zotero.Sync.Storage.StreamListener(
			{
				onProgress: function (a, b, c) {
					request.onProgress(a, b, c);
				},
				onStop: function (httpRequest, status, response, data) { onUploadComplete(httpRequest, status, response, data); },
				onCancel: function (httpRequest, status, data) { onUploadCancel(httpRequest, status, data); },
				request: request,
				item: item,
				uploadKey: uploadKey,
				streams: [mis]
			}
		);
		channel.notificationCallbacks = listener;
		
		var dispURI = uri.clone();
		if (dispURI.password) {
			dispURI.password = '********';
		}
		Zotero.debug("HTTP POST of " + file.leafName + " to " + dispURI.spec);
		
		channel.asyncOpen(listener, null);
	}
	
	
	function onUploadComplete(httpRequest, status, response, data) {
		var request = data.request;
		var item = data.item;
		var uploadKey = data.uploadKey;
		
		Zotero.debug("Upload of attachment " + item.key
			+ " finished with status code " + status);
		
		Zotero.debug(response);
		
		switch (status) {
			case 201:
				break;
			
			case 500:
				Zotero.Sync.Storage.EventManager.error(
					"File upload failed. Please try again."
				);
			
			default:
				var msg = "Unexpected file upload status " + status
					+ " in Zotero.Sync.Storage.ZFS.onUploadComplete()"
					+ " (" + Zotero.Items.getLibraryKeyHash(item) + ")";
				Zotero.debug(msg, 1);
				Components.utils.reportError(msg);
				Components.utils.reportError(response);
				Components.utils.reportError(msg);
				Zotero.Sync.Storage.EventManager.error(Zotero.Sync.Storage.defaultError);
		}
		
		var uri = getItemURI(item);
		var body = "update=" + uploadKey + "&mtime=" + item.attachmentModificationTime;
		
		// Register upload on server
		Zotero.HTTP.doPost(uri, body, function (req) {
			if (req.status != 204) {
				var msg = "Unexpected file registration status " + req.status
					+ " in Zotero.Sync.Storage.ZFS.onUploadComplete()"
					+ " (" + Zotero.Items.getLibraryKeyHash(item) + ")";
				Zotero.debug(msg, 1);
				Zotero.debug(req.responseText);
				Zotero.debug(req.getAllResponseHeaders());
				Components.utils.reportError(msg);
				Components.utils.reportError(req.responseText);
				Zotero.Sync.Storage.EventManager.error(Zotero.Sync.Storage.defaultError);
			}
			
			updateItemFileInfo(item);
			request.finish();
		});
	}
	
	
	function updateItemFileInfo(item) {
		// Mark as changed locally
		Zotero.DB.beginTransaction();
		Zotero.Sync.Storage.setSyncState(item.id, Zotero.Sync.Storage.SYNC_STATE_IN_SYNC);
		
		// Store file mod time
		var mtime = item.attachmentModificationTime;
		Zotero.Sync.Storage.setSyncedModificationTime(item.id, mtime, true);
		
		// Store file hash of individual files
		if (Zotero.Attachments.getNumFiles(item) == 1) {
			var hash = item.attachmentHash;
			Zotero.Sync.Storage.setSyncedHash(item.id, hash);
		}
		
		Zotero.DB.commitTransaction();
		
		try {
			if (Zotero.Attachments.getNumFiles(item) > 1) {
				var file = Zotero.getTempDirectory();
				file.append(item.key + '.zip');
				file.remove(false);
			}
		}
		catch (e) {
			Components.utils.reportError(e);
		}
		
		Zotero.Sync.Storage.EventManager.changesMade();
	}
	
	
	function onUploadCancel(httpRequest, status, data) {
		var request = data.request;
		var item = data.item;
		
		Zotero.debug("Upload of attachment " + item.key + " cancelled with status code " + status);
		
		try {
			if (Zotero.Attachments.getNumFiles(item) > 1) {
				var file = Zotero.getTempDirectory();
				file.append(item.key + '.zip');
				file.remove(false);
			}
		}
		catch (e) {
			Components.utils.reportError(e);
		}
		
		request.finish();
	}
	
	
	/**
	 * Get the storage URI for an item
	 *
	 * @inner
	 * @param	{Zotero.Item}
	 * @return	{nsIURI}					URI of file on storage server
	 */
	function getItemURI(item) {
		var uri = Zotero.Sync.Storage.ZFS.rootURI;
		// Be sure to mirror parameter changes to getItemInfoURI() below
		uri.spec += Zotero.URI.getItemPath(item) + '/file?auth=1&iskey=1&version=1';
		return uri;
	}
	
	
	/**
	 * Get the storage info URI for an item
	 *
	 * @inner
	 * @param	{Zotero.Item}
	 * @return	{nsIURI}					URI of file on storage server with info flag
	 */
	function getItemInfoURI(item) {
		var uri = Zotero.Sync.Storage.ZFS.rootURI;
		uri.spec += Zotero.URI.getItemPath(item) + '/file?auth=1&iskey=1&version=1&info=1';
		return uri;
	}
	
	
	function getUploadFile(item) {
		if (Zotero.Attachments.getNumFiles(item) > 1) {
			var file = Zotero.getTempDirectory();
			var filename = item.key + '.zip';
			file.append(filename);
		}
		else {
			var file = item.getFile();
		}
		return file;
	}
	
	
	//
	// Public methods (called via Zotero.Sync.Storage.ZFS)
	//
	var obj = new Zotero.Sync.Storage.Mode;
	obj.name = "ZFS";
	
	Object.defineProperty(obj, "includeUserFiles", {
		get: function () {
			return Zotero.Prefs.get("sync.storage.enabled") && Zotero.Prefs.get("sync.storage.protocol") == 'zotero';
		}
	});
	
	Object.defineProperty(obj, "includeGroupFiles", {
		get: function () {
			return Zotero.Prefs.get("sync.storage.groups.enabled");
		}
	});
	
	Object.defineProperty(obj, "_enabled", {
		get: function () this.includeUserFiles || this.includeGroupFiles
	});
	
	obj._verified = true;
	
	Object.defineProperty(obj, "rootURI", {
		get: function () {
			if (!_rootURI) {
				throw ("Root URI not initialized in Zotero.Sync.Storage.ZFS.rootURI");
			}
			return _rootURI.clone();
		}
	});
	
	Object.defineProperty(obj, "userURI", {
		get: function () {
			if (!_userURI) {
				throw ("User URI not initialized in Zotero.Sync.Storage.ZFS.userURI");
			}
			return _userURI.clone();
		}
	});
	
	
	obj._init = function (url, username, password) {
		var ios = Components.classes["@mozilla.org/network/io-service;1"].
					getService(Components.interfaces.nsIIOService);
		try {
			var uri = ios.newURI(url, null, null);
			if (username) {
				uri.username = username;
				uri.password = password;
			}
		}
		catch (e) {
			Zotero.debug(e, 1);
			Components.utils.reportError(e);
			return false;
		}
		_rootURI = uri;
		
		uri = uri.clone();
		uri.spec += 'users/' + Zotero.userID + '/';
		_userURI = uri;
		
		return true;
	};
	
	
	obj._initFromPrefs = function () {
		var url = ZOTERO_CONFIG.API_URL;
		var username = Zotero.Sync.Server.username;
		var password = Zotero.Sync.Server.password;
		return this._init(url, username, password);
	};
	
	
	/**
	 * Begin download process for individual file
	 *
	 * @param	{Zotero.Sync.Storage.Request}	[request]
	 */
	obj._downloadFile = function (request) {
		var item = Zotero.Sync.Storage.getItemFromRequestName(request.name);
		if (!item) {
			throw new Error("Item '" + request.name + "' not found");
		}
		
		// Retrieve file info from server to store locally afterwards
		getStorageFileInfo(item, function (item, info) {
			if (!request.isRunning()) {
				Zotero.debug("Download request '" + request.name
					+ "' is no longer running after getting remote file info");
				return;
			}
			
			if (!info) {
				Zotero.debug("Remote file not found for item " + item.libraryID + "/" + item.key);
				request.finish();
				return;
			}
			
			try {
				var syncModTime = info.mtime;
				var syncHash = info.hash;
				
				var file = item.getFile();
				// Skip download if local file exists and matches mod time
				if (file && file.exists()) {
					if (syncModTime == file.lastModifiedTime) {
						Zotero.debug("File mod time matches remote file -- skipping download");
						
						Zotero.DB.beginTransaction();
						var syncState = Zotero.Sync.Storage.getSyncState(item.id);
						//var updateItem = syncState != 1;
						var updateItem = false;
						Zotero.Sync.Storage.setSyncedModificationTime(item.id, syncModTime, updateItem);
						Zotero.Sync.Storage.setSyncState(item.id, Zotero.Sync.Storage.SYNC_STATE_IN_SYNC);
						Zotero.DB.commitTransaction();
						Zotero.Sync.Storage.EventManager.changesMade();
						request.finish();
						return;
					}
					// If not compressed, check hash, in case only timestamp changed
					else if (!info.compressed && item.attachmentHash == syncHash) {
						Zotero.debug("File hash matches remote file -- skipping download");
						
						Zotero.DB.beginTransaction();
						var syncState = Zotero.Sync.Storage.getSyncState(item.id);
						//var updateItem = syncState != 1;
						var updateItem = false;
						if (!info.compressed) {
							Zotero.Sync.Storage.setSyncedHash(item.id, syncHash, false);
						}
						Zotero.Sync.Storage.setSyncedModificationTime(item.id, syncModTime, updateItem);
						Zotero.Sync.Storage.setSyncState(item.id, Zotero.Sync.Storage.SYNC_STATE_IN_SYNC);
						Zotero.DB.commitTransaction();
						Zotero.Sync.Storage.EventManager.changesMade();
						request.finish();
						return;
					}
				}
				
				var destFile = Zotero.getTempDirectory();
				if (info.compressed) {
					destFile.append(item.key + '.zip.tmp');
				}
				else {
					destFile.append(item.key + '.tmp');
				}
				
				if (destFile.exists()) {
					try {
						destFile.remove(false);
					}
					catch (e) {
						Zotero.File.checkFileAccessError(e, destFile, 'delete');
					}
				}
				
				// saveURI() below appears not to create empty files for Content-Length: 0,
				// so we create one here just in case
				try {
					destFile.create(Components.interfaces.nsIFile.NORMAL_FILE_TYPE, 0644);
				}
				catch (e) {
					Zotero.File.checkFileAccessError(e, destFile, 'create');
				}
				
				var listener = new Zotero.Sync.Storage.StreamListener(
					{
						onStart: function (request, data) {
							if (data.request.isFinished()) {
								Zotero.debug("Download request " + data.request.name
									+ " stopped before download started -- closing channel");
								request.cancel(0x804b0002); // NS_BINDING_ABORTED
								return;
							}
						},
						onProgress: function (a, b, c) {
							request.onProgress(a, b, c)
						},
						onStop: function (request, status, response, data) {
							if (status != 200) {
								var msg = "Unexpected status code " + status
									+ " for request " + data.request.name
									+ " in Zotero.Sync.Storage.ZFS.downloadFile()";
								Zotero.debug(msg, 1);
								Components.utils.reportError(msg);
								Zotero.Sync.Storage.EventManager.error(Zotero.Sync.Storage.defaultError);
							}
							
							// Don't try to process if the request has been cancelled
							if (data.request.isFinished()) {
								Zotero.debug("Download request " + data.request.name
									+ " is no longer running after file download", 2);
								return;
							}
							
							Zotero.debug("Finished download of " + destFile.path);
							
							try {
								Zotero.Sync.Storage.processDownload(data);
								data.request.finish();
							}
							catch (e) {
								Zotero.Sync.Storage.EventManager.error(e);
							}
						},
						request: request,
						item: item,
						compressed: info.compressed,
						syncModTime: syncModTime,
						syncHash: syncHash
					}
				);
				
				var uri = getItemURI(item);
				
				// Don't display password in console
				var disp = uri.clone();
				if (disp.password) {
					disp.password = "********";
				}
				Zotero.debug('Saving ' + disp.spec + ' with saveURI()');
				const nsIWBP = Components.interfaces.nsIWebBrowserPersist;
				var wbp = Components
					.classes["@mozilla.org/embedding/browser/nsWebBrowserPersist;1"]
					.createInstance(nsIWBP);
				wbp.persistFlags = nsIWBP.PERSIST_FLAGS_BYPASS_CACHE;
				wbp.progressListener = listener;
				try {
					wbp.saveURI(uri, null, null, null, null, destFile);
				} catch(e if e.name === "NS_ERROR_XPC_NOT_ENOUGH_ARGS") {
					// https://bugzilla.mozilla.org/show_bug.cgi?id=794602
					// XXX Always use when we no longer support Firefox < 18
					wbp.saveURI(uri, null, null, null, null, destFile, null);
				}
			}
			catch (e) {
				Zotero.Sync.Storage.EventManager.error(e);
			}
		});
	};
	
	
	obj._uploadFile = function (request) {
		var item = Zotero.Sync.Storage.getItemFromRequestName(request.name);
		if (Zotero.Attachments.getNumFiles(item) > 1) {
			Zotero.Sync.Storage.createUploadFile(request, function (data) { processUploadFile(data); });
		}
		else {
			processUploadFile({ request: request });
		}
	};
	
	
	obj._getLastSyncTime = function (callback) {
		var uri = this.userURI;
		var successFileURI = uri.clone();
		successFileURI.spec += "laststoragesync?auth=1";
		
		// Cache the credentials at the root
		var self = this;
		this._cacheCredentials(function () {
			Zotero.HTTP.doGet(successFileURI, function (req) {
				if (req.responseText) {
					Zotero.debug(req.responseText);
				}
				Zotero.debug(req.status);
				
				if (req.status == 401 || req.status == 403) {
					Zotero.debug("Clearing ZFS authentication credentials", 2);
					_cachedCredentials = false;
				}
				
				if (req.status != 200 && req.status != 404) {
					Zotero.Sync.Storage.EventManager.error(
						"Unexpected status code " + req.status + " getting "
							+ "last file sync time"
					);
				}
				
				if (req.status == 200) {
					var ts = req.responseText;
					var date = new Date(ts * 1000);
					Zotero.debug("Last successful storage sync was " + date);
					_lastSyncTime = ts;
				}
				else {
					var ts = null;
					_lastSyncTime = null;
				}
				callback(ts);
			});
		});
	};
	
	
	obj._setLastSyncTime = function (callback, useLastSyncTime) {
		if (useLastSyncTime) {
			if (!_lastSyncTime) {
				if (callback) {
					callback();
				}
				return;
			}
			
			var sql = "REPLACE INTO version VALUES ('storage_zfs', ?)";
			Zotero.DB.query(sql, { int: _lastSyncTime });
			
			Zotero.debug("Clearing ZFS authentication credentials", 2);
			_lastSyncTime = null;
			_cachedCredentials = false;
			
			if (callback) {
				callback();
			}
			
			return;
		}
		_lastSyncTime = null;
		
		var uri = this.userURI;
		var successFileURI = uri.clone();
		successFileURI.spec += "laststoragesync?auth=1";
		
		Zotero.HTTP.doPost(successFileURI, "", function (req) {
			Zotero.debug(req.responseText);
			Zotero.debug(req.status);
			
			if (req.status != 200) {
				var msg = "Unexpected status code " + req.status + " setting last file sync time";
				Zotero.debug(msg, 1);
				Components.utils.reportError(msg);
				Zotero.Sync.Storage.EventManager.error(Zotero.Sync.Storage.defaultError);
			}
			
			var ts = req.responseText;
			
			var sql = "REPLACE INTO version VALUES ('storage_zfs', ?)";
			Zotero.DB.query(sql, { int: ts });
			
			Zotero.debug("Clearing ZFS authentication credentials", 2);
			_cachedCredentials = false;
			
			if (callback) {
				callback();
			}
		});
	};
	
	
	obj._cacheCredentials = function (callback) {
		if (_cachedCredentials) {
			Zotero.debug("Credentials are already cached");
			setTimeout(function () {
				callback();
			}, 0);
			return false;
		}
		
		var uri = this.rootURI;
		// TODO: move to root uri
		uri.spec += "?auth=1";
		Zotero.HTTP.doGet(uri, function (req) {
			if (req.status == 401) {
				// TODO: localize
				var msg = "File sync login failed\n\nCheck your username and password in the Sync pane of the Zotero preferences.";
				Zotero.Sync.Storage.EventManager.error(msg);
			}
			else if (req.status != 200) {
				var msg = "Unexpected status code " + req.status + " caching "
					+ "authentication credentials in Zotero.Sync.Storage.ZFS.cacheCredentials()";
				Zotero.debug(msg, 1);
				Components.utils.reportError(msg);
				Zotero.Sync.Storage.EventManager.error(Zotero.Sync.Storage.defaultErrorRestart);
			}
			Zotero.debug("Credentials are cached");
			_cachedCredentials = true;
			callback();
		});
		return true;
	};
	
	
	/**
	 * Remove all synced files from the server
	 */
	obj._purgeDeletedStorageFiles = function (callback) {
		// If we don't have a user id we've never synced and don't need to bother
		if (!Zotero.userID) {
			Zotero.Sync.Storage.EventManager.skip();
			return;
		}
		
		var sql = "SELECT value FROM settings WHERE setting=? AND key=?";
		var values = Zotero.DB.columnQuery(sql, ['storage', 'zfsPurge']);
		if (!values) {
			Zotero.Sync.Storage.EventManager.skip();
			return;
		}
		
		Zotero.debug("Unlinking synced files on ZFS");
		
		var uri = this.userURI;
		uri.spec += "removestoragefiles?";
		// Unused
		for each(var value in values) {
			switch (value) {
				case 'user':
					uri.spec += "user=1&";
					break;
				
				case 'group':
					uri.spec += "group=1&";
					break;
				
				default:
					Zotero.Sync.Storage.EventManager.error(
						"Invalid zfsPurge value '" + value + "' in ZFS purgeDeletedStorageFiles()"
					);
			}
		}
		uri.spec = uri.spec.substr(0, uri.spec.length - 1);
		
		Zotero.HTTP.doPost(uri, "", function (xmlhttp) {
			if (xmlhttp.status != 204) {
				if (callback) {
					callback(false);
				}
				Zotero.Sync.Storage.EventManager.error(
					"Unexpected status code " + xmlhttp.status + " purging ZFS files"
				);
			}
			
			var sql = "DELETE FROM settings WHERE setting=? AND key=?";
			Zotero.DB.query(sql, ['storage', 'zfsPurge']);
			
			if (callback) {
				callback(true);
			}
			
			Zotero.Sync.Storage.EventManager.success();
		});
	};
	
	return obj;
}());
