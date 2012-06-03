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

PDFJS.workerSrc = 'pdf.js';

window.addEventListener("message", function(event) {
	var message = event.data;
	if(typeof message !== "object") return;
	
	if(message.name === "Zotero.pdfToText") {
		var maxPages = message.maxPages;
		var errHandler = function(err) {
			window.postMessage({
				"name":"Zotero.pdfToText.response",
				"error":err.toString()
			}, "*");
		};
		
		PDFJS.getDocument(message.pdf).then(function(pdf) {
			try {
				var retrieved = 0;
				var contents = [];
				var nPages = maxPages ? Math.min(maxPages, pdf.numPages) : pdf.numPages;
				for(var j=0; j<nPages; j++) {
					let i = j;
					pdf.getPage(i+1).then(function(page) {
						page.getTextContent().then(function(textContent) {
							try {
								contents[i] = textContent;
								if(++retrieved === nPages) {
									window.postMessage({
										"name":"Zotero.pdfToText.response",
										"response":{
											"text":contents.join("\n"),
											"pagesConverted":nPages,
											"pagesTotal":pdf.numPages
										}
									}, "*");
								}
							} catch(e) {
								errHandler(e);
							}
						}, errHandler);
					}, errHandler);
				}
			} catch(e) {
				errHandler(e);
			}
		}, errHandler);
	}
}, false);