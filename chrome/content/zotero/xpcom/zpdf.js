/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2012 Center for History and New Media
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

Zotero.PDF = new function(){
	Components.utils.import("resource://gre/modules/Services.jsm");
	Components.utils.import("resource://zotero/q.jsm");
	
	var _pdfjsWindow;
	
	/**
	 * Converts a PDF to a text string
	 * @param {nsIFile} file
	 * @param {Integer} maxPages The maximum number of pages to convert, or omitted to
	 *     convert all pages
	 * @return {Promise} A promise that resolves with an object in the form
	 *     {"text":<<PDF TEXT CONTENT>>, "pagesConverted":<<NUMBER OF PAGES CONVERTED>>,
	 *      "pagesTotal":<<TOTAL NUMBER OF PAGES IN PDF>>}
	 */
	this.pdfToText = function(file, maxPages) {
		return _sendMessageToPDFJS("Zotero.PDF.pdfToText", {
			"pdf":_fileToUint8Array(file),
			"maxPages":maxPages
		});
	};
	
	
	/**
	 * Gets metadata string from a PDF
	 * @param {nsIFile} file
	 * @return {Promise} A promise that resolves with the metadata object for the PDF
	 */
	this.getMetadata = function(file) {
		var translate = new Zotero.Translate.Import();
		
		return _sendMessageToPDFJS("Zotero.PDF.getMetadata", {
			"pdf":_fileToUint8Array(file)
		}).then(function(xmpMetadata) {
			translate.setTranslator("5e3ad958-ac79-463d-812b-a86a9235c28f");
			translate.setString(xmpMetadata);
			var promise = translate.getPromise("done");
			translate.translate(false);
			return promise;
		}).then(function(output) {
			if(output[0] && translate.newItems.length) {
				return translate.newItems[0];
			} else {
				return false;
			}
		});
	}
	
	/**
	 * Loads a file into a Uint8 array. This is not a great way of doing it, but I don't
	 * know any other performant options.
	 */
	function _fileToUint8Array(file) {
		var iStream = Components.classes["@mozilla.org/network/file-input-stream;1"]
					 .createInstance(Components.interfaces.nsIFileInputStream);
		iStream.init(file, 0x01, 0664, 0);
		var bStream = Components.classes["@mozilla.org/binaryinputstream;1"]
					 .createInstance(Components.interfaces.nsIBinaryInputStream);
		bStream.setInputStream(iStream);
		var bytes = bStream.readByteArray(file.fileSize);
		iStream.close();
		return new Uint8Array(bytes);
	}
	
	/**
	 * Gets an instance of PDFJS
	 */
	function _getPDFJSWindow() {
		if(_pdfjsWindow) {
			return Q.fcall(function() {
				return _pdfjsWindow;
			});
		} else {
			var deferred = Q.defer();
			
			// Get file:/// URI for pdf.js
			var uri = Services.io.newURI("chrome://zotero/content/pdfjs/container.html", null, null);
			uri = Components.classes["@mozilla.org/chrome/chrome-registry;1"]
					.getService(Components.interfaces.nsIChromeRegistry).convertChromeURL(uri);
			
			// Load pdf.js in a new hidden browser
			var browser = Zotero.Browser.createHiddenBrowser();
			var listener = function(event) {
				if(browser.contentDocument.documentURI === "about:blank") return;
				browser.removeEventListener("DOMContentLoaded", listener, false);
				_pdfjsWindow = browser.contentWindow;
				deferred.resolve(_pdfjsWindow);
			};
			browser.addEventListener("DOMContentLoaded", listener, false);
			browser.loadURI(uri.path);
			Zotero.addShutdownListener(function() {
				Zotero.Browser.deleteHiddenBrowser(browser);
			});
			
			return deferred.promise;
		}
	};
	
	/**
	 * Sends a message with the given name and data to pdf.js, and waits for a response.
	 */
	function _sendMessageToPDFJS(name, payload) {
		payload.name = name;
		return _getPDFJSWindow().then(function(pdfjsWindow) {
			var deferred = Q.defer(), listener = function(event) {
				var message = event.data;
				if(typeof message !== "object"
					|| message.name !== name+".response") return;
				
				pdfjsWindow.removeEventListener("message", listener, false);
				
				if(message.error) {
					deferred.reject(message.error);
				} else {
					deferred.resolve(message.response);
				}
			};
			pdfjsWindow.addEventListener("message", listener, false);
			pdfjsWindow.postMessage(payload, "*");
			
			return deferred.promise;
		});
	}
}
