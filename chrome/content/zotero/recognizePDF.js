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

/**
 * @fileOverview Tools for automatically retrieving a citation for the given PDF
 */
const Zotero_RecognizePDF_SUCCESS_IMAGE = "chrome://zotero/skin/tick.png";
const Zotero_RecognizePDF_FAILURE_IMAGE = "chrome://zotero/skin/cross.png";
const Zotero_RecognizePDF_LOADING_IMAGE = "chrome://global/skin/icons/loading_16.png";
 
/**
 * Front end for recognizing PDFs
 * @namespace
 */
var Zotero_RecognizePDF = new function() {
	var _progressWindow, _progressIndicator;
	
	/**
	 * Checks whether a given PDF could theoretically be recognized
	 * @returns {Boolean} True if the PDF can be recognized, false if it cannot be
	 */
	this.canRecognize = function(/**Zotero.Item*/ item) {
		return (item.attachmentMIMEType &&
			item.attachmentMIMEType == "application/pdf" && !item.getSource());
	}
	
	/**
	 * Retrieves metadata for the PDF(s) selected in the Zotero Pane, placing the PDFs as a children
	 * of the new items
	 */
	this.recognizeSelected = function() {
		var items = ZoteroPane_Local.getSelectedItems();
		if (!items) return;
		var itemRecognizer = new Zotero_RecognizePDF.ItemRecognizer();
		itemRecognizer.recognizeItems(items);
	}
}

/**
 * @class Handles UI, etc. for recognizing multiple items
 */
Zotero_RecognizePDF.ItemRecognizer = function () {
	this._stopped = false;
}

/**
 * Retreives metadata for the PDF items passed, displaying a progress dialog during conversion 
 * and placing the PDFs as a children of the new items
 * @param {Zotero.Item[]} items
 */
Zotero_RecognizePDF.ItemRecognizer.prototype.recognizeItems = function(items) {
	var me = this;
	this._items = items.slice();
	this._itemTotal = items.length;
	
	this._progressWindow = window.openDialog("chrome://zotero/content/pdfProgress.xul", "", "chrome,close=yes,resizable=yes,dependent,dialog,centerscreen");
	this._progressWindow.addEventListener("pageshow", function() { me._onWindowLoaded() }, false);
}

/**
 * Halts recognition of PDFs
 */
Zotero_RecognizePDF.ItemRecognizer.prototype.stop = function() {
	this._stopped = true;	
}

/**
 * Called when the progress window has been opened; adds items to the tree and begins recognizing
 * @param
 */
Zotero_RecognizePDF.ItemRecognizer.prototype._onWindowLoaded = function() {
	// populate progress window
	var treechildren = this._progressWindow.document.getElementById("treechildren");
	for(var i in this._items) {
		var treeitem = this._progressWindow.document.createElement('treeitem');
		var treerow = this._progressWindow.document.createElement('treerow');
		
		var treecell = this._progressWindow.document.createElement('treecell');
		treecell.setAttribute("id", "item-"+this._items[i].id+"-icon");
		treerow.appendChild(treecell);
		
		treecell = this._progressWindow.document.createElement('treecell');
		treecell.setAttribute("label", this._items[i].getField("title"));
		treerow.appendChild(treecell);
		
		treecell = this._progressWindow.document.createElement('treecell');
		treecell.setAttribute("id", "item-"+this._items[i].id+"-title");
		treerow.appendChild(treecell);
		
		treeitem.appendChild(treerow);
		treechildren.appendChild(treeitem);
	}
	
	var me = this;
	this._progressIndicator = this._progressWindow.document.getElementById("progress-indicator");
	this._progressWindow.document.getElementById("cancel-button").addEventListener("command", function() {
		me.stop();
		me._progressWindow.close();
	}, false);
	this._progressWindow.addEventListener("close", function() { me.stop() }, false);
	this._recognizeItem();
}

/**
 * Shifts an item off of this._items and recognizes it, then calls itself again if there are more
 * @private
 */
Zotero_RecognizePDF.ItemRecognizer.prototype._recognizeItem = function() {
	if(!this._items.length) {
		this._done();
		return;
	}
	
	this._progressIndicator.value = (this._itemTotal-this._items.length)/this._itemTotal*100;
	this._item = this._items.shift();
	
	this._progressWindow.document.getElementById("item-"+this._item.id+"-icon").
		setAttribute("src", Zotero_RecognizePDF_LOADING_IMAGE);
	
	var file = this._item.getFile();
	if(file) {
		var recognizer = new Zotero_RecognizePDF.Recognizer();
		var me = this;
		recognizer.recognize(file, this._item.libraryID, function(newItem, error) { me._callback(newItem, error) });
	} else {
		this._callback(false, "recognizePDF.fileNotFound");
	}
}

/**
 * Cleans up after items are recognized, disabling the cancel button and making the progress window
 * close on blur
 */
Zotero_RecognizePDF.ItemRecognizer.prototype._done = function() {
	this._progressIndicator.value = 100;
	this._progressWindow.document.getElementById("cancel-button").label = Zotero.getString("recognizePDF.close.label");
	var me = this;
	this._progressWindow.addEventListener("blur",
		function() { me._progressWindow.setTimeout(function() { me._progressWindow.close() }, 2000) }, false);
	this._progressWindow.document.getElementById("label").value = Zotero.getString("recognizePDF.complete.label");
}

/**
 * Callback function to be executed upon recognition completion
 * @param {Zotero.Item|Boolean} newItem The new item created from translation, or false if
 *	recognition was unsuccessful
 * @param {String} [error] The error name, if recognition was unsuccessful.
 */
Zotero_RecognizePDF.ItemRecognizer.prototype._callback = function(newItem, error) {
	if(this._stopped) {
		if(newItem) Zotero.Items.erase(newItem.id);
		return;
	}
	
	if(newItem) {
		// put new item in same collections as the old one
		var itemCollections = this._item.getCollections();
		for(var j=0; j<itemCollections.length; j++) {
			var collection = Zotero.Collections.get(itemCollections[j]);
			collection.addItem(newItem.id);
		}
		
		// put old item as a child of the new item
		this._item.setSource(newItem.id);
		this._item.save();	
	}
		
	// add name
	this._progressWindow.document.getElementById("item-"+this._item.id+"-title").
		setAttribute("label", (newItem ? newItem.getField("title") : Zotero.getString(error)));
	// update icon
	this._progressWindow.document.getElementById("item-"+this._item.id+"-icon").
		setAttribute("src", (newItem ? Zotero_RecognizePDF_SUCCESS_IMAGE : Zotero_RecognizePDF_FAILURE_IMAGE));
	
	if(error == "recognizePDF.limit") {
		// now done, since we hit the query limit
		var error = Zotero.getString(error);
		for(var i in this._items) {
			this._progressWindow.document.getElementById("item-"+this._items[i].id+"-title").
				setAttribute("label", error);
			this._progressWindow.document.getElementById("item-"+this._items[i].id+"-icon").
				setAttribute("src", Zotero_RecognizePDF_FAILURE_IMAGE);
		}
		this._done();
	} else {
		// scroll to this item
		this._progressWindow.document.getElementById("tree").treeBoxObject.scrollToRow(Math.max(0, this._itemTotal-this._items.length-5));
		// continue recognizing
		this._recognizeItem();
	}
}

/*Zotero_RecognizePDF.ItemRecognizer.prototype._captchaCallback = function(img) {
	var io = {dataIn:img};
	Zotero.debug(img);
	this._progressWindow.openDialog("chrome://zotero/content/pdfCaptcha.xul", "", "chrome,modal,resizable=no", io);
	
	if(io.dataOut) return io.dataOut;
	
	this.stop();
	this._progressWindow.close();
	return false;
}*/

/**
 * @class PDF recognizer backend
 */
Zotero_RecognizePDF.Recognizer = function () {}

/**
 * Retrieves metadata for a PDF and saves it as an item
 *
 * @param {nsIFile} file The PDF file to retrieve metadata for
 * @param {Function} callback The function to be executed when recognition is complete
 * @param {Function} [captchaCallback] The function to be executed if a CAPTCHA is encountered
 *	(function will be passed image as URL and must return text of CAPTCHA)
 */
Zotero_RecognizePDF.Recognizer.prototype.recognize = function(file, libraryID, callback, captchaCallback) {
	this._libraryID = libraryID;
	this._callback = callback;
	//this._captchaCallback = captchaCallback;
	
	var me = this;
	Zotero.PDF.getMetadata(file).then(function(metadata) {
		Zotero.debug("Parsed RDF from PDF");
		Zotero.debug(metadata);
		var shouldUse = metadata && metadata.title && metadata.date && metadata.creators.length;
		if(shouldUse) {
			switch(metadata.itemType) {
				case "journalArticle":
					shouldUse = metadata.itemType === "journalArticle"
						&& metadata.publicationTitle && metadata.volume && metadata.pages;
					break;
				case "book":
					shouldUse = metadata.itemType === "book"
						&& metadata.publisher;
					break;
			}
		}
			
		if(shouldUse) {
			var itemSaver = new Zotero.Translate.ItemSaver(libraryID, 0);
			itemSaver.saveItems([metadata], function(success, items) {
				if(success) {
					me._callback(items[0]);
				} else {
					me._callback(false, "recognizePDF.unexpectedError");
				}
			});
		} else {
			if(metadata.DOI) me._DOI = metadata.DOI;
			me._loadText(file);
		}
	}).fail(function(err) {
		Zotero.logError(err);
		me._loadText(file);
	});
}

/**
 * Loads text out of the PDF and looks for a DOI or queries Google
 */
Zotero_RecognizePDF.Recognizer.prototype._loadText = function(file) {
	const MAX_PAGES = 7;
	const MAX_LINES = 80;
	
	var me = this;
	Zotero.PDF.pdfToText(file, MAX_PAGES).then(function(response) {
		Zotero.debug(response);
		var text = response.text,
			dirtyLines = text.split("\n"),
			lines = [],
			lineLengths = [];
		
		const lineRe = /^\s*([^\s]+(?: [^\s]+)+)/;
		for(var i=0; i<dirtyLines.length && lines.length < 80; i++) {
			var m = lineRe.exec(dirtyLines[i]);
			if(m) {
				lines.push(m[1]);
				lineLengths.push(m[1].length);
			}
		}
		
		// look for DOI
		var m = Zotero.Utilities.cleanDOI(text);
		if(m && !me._DOI) {
			me._DOI = m[0];
		}
		var isbns = me._findISBNs(text);
		if(isbns.length) this._ISBN = isbns[0];
		
		// get (not quite) median length
		var lineLengthsLength = lineLengths.length;
		if(lineLengthsLength < 20
				|| lines[0] === "This is a digital copy of a book that was preserved for generations on library shelves before it was carefully scanned by Google as part of a project") {
			me._callback(false, "recognizePDF.noOCR");
		} else {		
			var sortedLengths = lineLengths.sort();
			var medianLength = sortedLengths[Math.floor(lineLengthsLength/2)];
			
			// pick lines within 4 chars of the median (this is completely arbitrary)
			me._goodLines = [];
			var uBound = medianLength + 4;
			var lBound = medianLength - 4;
			for (var i=0; i<lineLengthsLength; i++) {
				if(lineLengths[i] > lBound && lineLengths[i] < uBound) {
					// Strip quotation marks so they don't mess up search query quoting
					var line = lines[i].replace('"', '');
					me._goodLines.push(line);
				}
			}
			
			me._startLine = me._iteration = 0;
			me._queryGoogle();
		}
	}).fail(function(err) {
		Zotero.logError(err);
		me._callback(false, "recognizePDF.couldNotRead");
	});
}

/**
 * Search ISBNs in text
 * @private
 * @return array with ISBNs
 */
Zotero_RecognizePDF.Recognizer.prototype._findISBNs = function(x) {
	if(typeof(x) != "string") {
		throw "findISBNs: argument must be a string";
	}
	var isbns = [];

	// Match lines saying "isbn: " or "ISBN-10:" or similar, consider m-dashes and n-dashes as well
	var pattern = /(SBN|sbn)[ \u2014\u2013\u2012-]?(10|13)?[: ]*([0-9X][0-9X \u2014\u2013\u2012-]+)/g; 
	var match;
	
	while (match = pattern.exec(x)) {
		var isbn = match[3];
		isbn = isbn.replace(/[ \u2014\u2013\u2012-]/g, '');
		if(isbn.length==20 || isbn.length==26) { 
			// Handle the case of two isbns (e.g. paper+hardback) next to each other
			isbns.push(isbn.slice(0,isbn.length/2), isbn.slice(isbn.length/2));
		} else if(isbn.length==23) { 
			// Handle the case of two isbns (10+13) next to each other
			isbns.push(isbn.slice(0,10), isbn.slice(10));
		} else if(isbn.length==10 || isbn.length==13) {
			isbns.push(isbn);
		}
	}

	// Validate ISBNs
	var validIsbns = [];
	for (var i =0; i < isbns.length; i++) {
		if(this._isValidISBN(isbns[i])) validIsbns.push(isbns[i]);
	}
	return validIsbns;
}

Zotero_RecognizePDF.Recognizer.prototype._isValidISBN = function(isbn) {
	if(isbn.length == 13) {
		// ISBN-13 should start with 978 or 979 i.e. GS1 for book publishing industry
		var prefix = isbn.slice(0,3);
		if (prefix != "978" && prefix != "979") return false;
		// Verify check digit
		var check = 0;
		for (var i = 0; i < 13; i+=2) check += isbn[i]*1;
		for (i = 1; i < 12; i+=2) check += 3 * isbn[i]*1;
		return (check % 10 == 0);
	} else if(isbn.length == 10) {
		// Verify ISBN-10 check digit
		var check = 0;
		for (var i = 0; i < 9; i++) check += isbn[i]*1 * (10-i);
		// last number might be 'X'
		if (isbn[9] == 'X' || isbn[9] == 'x') check += 10;
		else check += isbn[i]*1;
		return (check % 11 == 0);
	}
	return false;
}

/**
 * Queries Google Scholar for metadata for this PDF
 * @private
 */
Zotero_RecognizePDF.Recognizer.prototype._queryGoogle = function() {
	if(this._iteration > 3 || this._startLine >= this._goodLines.length) {
		try {
			if(this._hiddenBrowser) Zotero.Browser.deleteHiddenBrowser(me._hiddenBrowser);
		} catch(e) {}
		this._callback(false, "recognizePDF.noMatches");
		return;
	}
	this._iteration++;

	var queryString = "";
	var me = this;
	if(this._DOI || this._ISBN) {
		var translate = new Zotero.Translate.Search();
		var item = {};
		if(this._DOI) {
			// use CrossRef to look for DOI
			translate.setTranslator("11645bd1-0420-45c1-badb-53fb41eeb753");
			item = {"itemType":"journalArticle", "DOI":this._DOI};
		} else if(this._ISBN) {
			// use Open WorldCat to look for ISBN
			translate.setTranslator("c73a4a8c-3ef1-4ec8-8229-7531ee384cc4"); 
			item = {"itemType":"book", "ISBN":this._ISBN};
		}
		translate.setSearch(item);
		translate.setHandler("itemDone", function(translate, item) {
			me._callback(item);
		});
		translate.setHandler("select", function(translate, items, callback) {
			return me._selectItems(translate, items, callback);
		});
		translate.setHandler("done", function(translate, success) {
			if(!success) me._queryGoogle();
		});
		translate.translate(this._libraryID, false);
		if(this._DOI) delete this._DOI;
		else if(this._ISBN) delete this.ISBN;
	} else {
		// take the relevant parts of some lines (exclude hyphenated word)
		var queryStringWords = 0;
		while(queryStringWords < 25 && this._startLine < this._goodLines.length) {
			var words = this._goodLines[this._startLine].split(/\s+/);
			// get rid of first and last words
			words.shift();
			words.pop();
			// make sure there are no long words (probably OCR mistakes)
			var skipLine = false;
			for(var i=0; i<words.length; i++) {
				if(words[i].length > 20) {
					skipLine = true;
					break;
				}
			}
			// add words to query
			if(!skipLine && words.length) {
				queryStringWords += words.length;
				queryString += '"'+words.join(" ")+'" ';
			}
			this._startLine++;
		}
		
		Zotero.debug("RecognizePDF: Query string "+queryString);
		
		// pass query string to Google Scholar and translate
		var url = "http://scholar.google.com/scholar?q="+encodeURIComponent(queryString)+"&hl=en&lr=&btnG=Search";
		if(!this._hiddenBrowser) {
			this._hiddenBrowser = Zotero.Browser.createHiddenBrowser();
			this._hiddenBrowser.docShell.allowImages = false;
		}
		
		var translate = new Zotero.Translate.Web();
		var savedItem = false;
		translate.setTranslator("57a00950-f0d1-4b41-b6ba-44ff0fc30289");
		translate.setHandler("itemDone", function(translate, item) {
			Zotero.Browser.deleteHiddenBrowser(me._hiddenBrowser);
			savedItem = true;
			me._callback(item);
		});
		translate.setHandler("select", function(translate, items, callback) {
			me._selectItems(translate, items, callback);
		});
		translate.setHandler("done", function(translate, success) {
			if(!success || !savedItem) me._queryGoogle();
		});
		translate.setHandler("translators", function(translate, detected) { 
				if(detected.length) {
					translate.translate(me._libraryID, false);
				} else {
					me._queryGoogle();
				}
		});
		
		this._hiddenBrowser.addEventListener("pageshow", function() { me._scrape(translate) }, true);
		
		this._hiddenBrowser.loadURIWithFlags(url,
			Components.interfaces.nsIWebNavigation.LOAD_FLAGS_BYPASS_HISTORY, null, null, null);
	}
}

/**
 * To be executed when Google Scholar is loaded
 * @private
 */
Zotero_RecognizePDF.Recognizer.prototype._scrape = function(/**Zotero.Translate*/ translate) {
	if(this._hiddenBrowser.contentDocument.location.href == "about:blank") return;
	
	if(this._hiddenBrowser.contentDocument.title == "403 Forbidden") {
		// hit the captcha
		/*
		var forms = this._hiddenBrowser.contentDocument.getElementsByTagName("form");
		if(forms.length && forms[0].getAttribute("action") == "Captcha") {
			var captchaImage = forms[0].getElementsByTagName("img");
			var captchaBox = this._hiddenBrowser.contentDocument.getElementsByName("captcha");
			if(captchaImage.length && captchaBox.length && this._captchaCallback) {
				var text = this._captchaCallback(captchaImage[0].src);
				if(text) {
					captchaBox[0].value = text;
					forms[0].submit();
					return;
				}
			}
		}*/
		this._callback(false, "recognizePDF.limit");
		return;
	}

	this._hiddenBrowser.removeEventListener("pageshow", this._scrape.caller, true);
	translate.setDocument(this._hiddenBrowser.contentDocument);

	translate.getTranslators(false, true);
}

/**
 * Callback to pick first item in the Google Scholar item list
 * @private
 * @type Object
 */
Zotero_RecognizePDF.Recognizer.prototype._selectItems = function(/**Zotero.Translate*/ translate,
		/**Object*/ items, /**Function**/ callback) {
	for(var i in items) {
		var obj = {};
		obj[i] = items;
		callback(obj);
		return;
	}
}
