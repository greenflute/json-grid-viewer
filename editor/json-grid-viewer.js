const vscode = require( 'vscode' )
const hjson = require('hjson')
const path = require( 'path' )
const getNonce  = require( './util' ).getNonce

class JsonGridViewer {
  constructor( document, webviewPanel, context ) {
    this.document = document
    this.webviewPanel = webviewPanel
    this.context = context

    // Setup initial content for the webview
		this.webviewPanel.webview.options = {
			enableScripts: true,
			retainContextWhenHidden: true,
		}

		this.webviewPanel.webview.html = this.getHtmlForWebview()

    // Create document change listener to update the webview
		this.changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document.uri.toString() === this.document.uri.toString()) {
				this.updateWebview()
			}
		});

    // Create listener to process messages from the webview
		this.webviewPanel.webview.onDidReceiveMessage( msg => {
			switch (msg.type) {
				case 'ready':
					this.updateWebview()
					break;
				case 'edit':
					this.applyEdit( msg )
					break;
				case 'rename-key':
					this.applyRenameKey( msg )
					break;
			}
    })

  }

	getHtmlForWebview() {
		// Local path to script and css for the webview
		const appUri = this.webviewPanel.webview.asWebviewUri( vscode.Uri.file(
			path.join( this.context.extensionPath, 'webview', 'js', 'app.js' )
		))
		const chunkVendorsUri = this.webviewPanel.webview.asWebviewUri( vscode.Uri.file(
			path.join( this.context.extensionPath, 'webview', 'js', 'chunk-vendors.js' )
		))
		const appCssUri = this.webviewPanel.webview.asWebviewUri( vscode.Uri.file(
			path.join( this.context.extensionPath, 'webview', 'css', 'app.css' )
		))

		const nonce = getNonce()

		return `
		<!DOCTYPE html>
		<html lang="en">
			<head>
				<meta charset="utf-8">
				<meta name="viewport" content="width=device-width,initial-scale=1.0">
				<meta http-equiv="Content-Security-Policy"
					content="default-src 'none';
					style-src ${this.webviewPanel.webview.cspSource};
					script-src 'nonce-${nonce}';"
				/>
				<title>JSON Grid viewer</title>
				<link href="${appCssUri}" rel="stylesheet">
			</head>
			<body>
				<div id="app"></div>
				<script nonce="${nonce}" src="${chunkVendorsUri}"></script>
				<script nonce="${nonce}" src="${appUri}"></script>
			</body>
		</html>
		`
	}

	// Hook up event handlers so that we can synchronize the webview with the text document.
	updateWebview() {
		let doc
		try {
			doc = this.parseDocument()
		} catch (error) {
			return
		}
		this.webviewPanel.webview.postMessage({
			type: 'update',
			doc
		})
	}

	async applyEdit( msg ) {
		let jsonDoc
		let value

		try {
			jsonDoc = this.parseDocument()
			value = hjson.parse( msg.value )
		} catch (error) {
			vscode.window.showErrorMessage( `Invalid JSON input: ${error.message}` )
			return
		}

		try {
			if ( msg.path.length === 0 ) {
				jsonDoc = value
			} else {
				const parent = this.getValueAtPath( jsonDoc, msg.path.slice( 0, -1 ) )
				parent[msg.path[msg.path.length - 1]] = value
			}

			await this.replaceDocument( jsonDoc )
		} catch (error) {
			vscode.window.showErrorMessage( `Could not update JSON: ${error.message}` )
		}
	}

	async applyRenameKey( msg ) {
		const oldKey = msg.path[msg.path.length - 1]
		const parentPath = msg.path.slice( 0, -1 )
		const nextKey = msg.nextKey.trim()

		if ( !nextKey ) {
			vscode.window.showErrorMessage( 'Property name cannot be empty.' )
			return
		}

		if ( nextKey === oldKey ) {
			return
		}

		let jsonDoc
		try {
			jsonDoc = this.parseDocument()
		} catch (error) {
			vscode.window.showErrorMessage( `Could not rename property: ${error.message}` )
			return
		}

		const parent = this.getValueAtPath( jsonDoc, parentPath )
		if ( !parent || Array.isArray( parent ) || typeof parent !== 'object' ) {
			vscode.window.showErrorMessage( 'Property rename is only supported inside JSON objects.' )
			return
		}

		if ( !Object.prototype.hasOwnProperty.call( parent, oldKey ) ) {
			vscode.window.showErrorMessage( `Property "${oldKey}" was not found.` )
			return
		}

		if ( Object.prototype.hasOwnProperty.call( parent, nextKey ) ) {
			vscode.window.showErrorMessage( `Property "${nextKey}" already exists.` )
			return
		}

		const renamed = {}
		Object.keys( parent ).forEach( key => {
			renamed[key === oldKey ? nextKey : key] = parent[key]
		} )

		if ( parentPath.length === 0 ) {
			jsonDoc = renamed
		} else {
			const grandParent = this.getValueAtPath( jsonDoc, parentPath.slice( 0, -1 ) )
			grandParent[parentPath[parentPath.length - 1]] = renamed
		}

		await this.replaceDocument( jsonDoc )
	}

	getValueAtPath( root, path ) {
		return path.reduce( ( value, segment ) => {
			if ( value === null || value === undefined ) {
				throw new Error( `Path segment "${segment}" could not be resolved.` )
			}
			return value[segment]
		}, root )
	}

	async replaceDocument( value ) {
		const edit = new vscode.WorkspaceEdit()
		edit.replace( this.document.uri, this.getFullDocumentRange(), this.stringifyDocument( value ) )
		await vscode.workspace.applyEdit( edit )
	}

	parseDocument() {
		const text = this.document.getText()
		if ( !this.isJsonlDocument() ) {
			return hjson.parse( text )
		}

		return text
			.split( /\r?\n/ )
			.map( ( line, index ) => ({
				line: line.trim(),
				lineNumber: index + 1,
			}) )
			.filter( entry => entry.line )
			.map( entry => {
				try {
					return hjson.parse( entry.line )
				} catch (error) {
					throw new Error( `Line ${entry.lineNumber}: ${error.message}` )
				}
			} )
	}

	stringifyDocument( value ) {
		if ( !this.isJsonlDocument() ) {
			return hjson.stringify( value )
		}

		if ( !Array.isArray( value ) ) {
			throw new Error( 'JSONL document root must be an array.' )
		}

		return value.map( item => JSON.stringify( item ) ).join( '\n' )
	}

	isJsonlDocument() {
		return this.document.uri.fsPath.toLowerCase().endsWith( '.jsonl' )
	}

	getFullDocumentRange() {
		const lastLine = Math.max( this.document.lineCount - 1, 0 )
		const lastChar = this.document.lineAt( lastLine ).text.length
		return new vscode.Range( 0, 0, lastLine, lastChar )
	}
  
  // remove any listeners
  cleanup() {
    this.changeDocumentSubscription.dispose()
  }
}

exports.JsonGridViewer = JsonGridViewer
