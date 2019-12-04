/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as fs from 'fs';

import {
  IPCMessageReader,
  IPCMessageWriter,
  createConnection,
  IConnection,
  TextDocuments,
  InitializeResult,
  InitializeParams,
  DocumentSymbolParams,
  SymbolInformation,
  TextDocumentPositionParams,
  CompletionItem,
  StreamMessageReader,
  StreamMessageWriter,
  ReferenceParams,
  Location
} from 'vscode-languageserver';

import ProjectRoots from './project-roots';
import DefinitionProvider from './definition-providers/entry';
import TemplateLinter from './template-linter';
import DocumentSymbolProvider from './symbols/document-symbol-provider';
import JSDocumentSymbolProvider from './symbols/js-document-symbol-provider';
import HBSDocumentSymbolProvider from './symbols/hbs-document-symbol-provider';
import { ReferenceProvider } from './reference-provider/entry';
import { log } from './utils/logger';
import TemplateCompletionProvider from './completion-provider/template-completion-provider';
import ScriptCompletionProvider from './completion-provider/script-completion-provider';
import { uriToFilePath } from 'vscode-languageserver/lib/files';

export default class Server {
  // Create a connection for the server. The connection defaults to Node's IPC as a transport, but
  // also supports stdio via command line flag
  connection: IConnection = process.argv.includes('--stdio')
    ? createConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout))
    : createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

  // Create a simple text document manager. The text document manager
  // supports full document sync only
  documents: TextDocuments = new TextDocuments();

  projectRoots: ProjectRoots = new ProjectRoots();

  documentSymbolProviders: DocumentSymbolProvider[] = [new JSDocumentSymbolProvider(), new HBSDocumentSymbolProvider()];

  templateCompletionProvider: TemplateCompletionProvider = new TemplateCompletionProvider(this);
  scriptCompletionProvider: ScriptCompletionProvider = new ScriptCompletionProvider(this);

  definitionProvider: DefinitionProvider = new DefinitionProvider(this);

  templateLinter: TemplateLinter = new TemplateLinter(this);

  referenceProvider: ReferenceProvider = new ReferenceProvider(this);

  constructor() {
    // Make the text document manager listen on the connection
    // for open, change and close text document events
    this.documents.listen(this.connection);

    // Bind event handlers
    this.connection.onInitialize(this.onInitialize.bind(this));
    this.documents.onDidChangeContent(this.onDidChangeContent.bind(this));
    this.connection.onDidChangeWatchedFiles(this.onDidChangeWatchedFiles.bind(this));
    this.connection.onDocumentSymbol(this.onDocumentSymbol.bind(this));
    this.connection.onDefinition(this.definitionProvider.handler);
    this.connection.onCompletion(this.onCompletion.bind(this));
    this.connection.onExecuteCommand(this.onExecute.bind(this));
    this.connection.onReferences(this.onReference.bind(this));
    this.connection.telemetry.logEvent({ connected: true });
    // this.displayInfoMessage('Ember Language Server [activated]');
    // 'els.showStatusBarText'

    // let params: ExecuteCommandParams = {
    // command,
    // arguments: args
    // };
    // return client.sendRequest(ExecuteCommandRequest.type, params)

    // this.connection.client.sendRequest()
    // this.connection.onEx
  }

  /**
   * Custom Notifications
   */

  displayInfoMessage(msg: string): void {
    this.connection.sendNotification('$/displayInfo', msg);
  }
  displayWarningMessage(msg: string): void {
    this.connection.sendNotification('$/displayWarning', msg);
  }
  displayErrorMessage(msg: string): void {
    this.connection.sendNotification('$/displayError', msg);
  }

  onExecute(params: string[]) {
    if (params[0] === 'els:registerProjectPath') {
      this.projectRoots.onProjectAdd(params[1], this);
    }
    return params;
  }

  listen() {
    this.connection.listen();
  }

  // Addon API allow patch this object to get more capabilities inside onInit method
  capabilities = {
    // Tell the client that the server works in FULL text document sync mode
    definitionProvider: true,
    executeCommandProvider: {
      commands: ['els:registerProjectPath']
    },
    documentSymbolProvider: true,
    referencesProvider: true,
    completionProvider: {
      resolveProvider: true,
      triggerCharacters: ['.', '::', '=', '/', '{{', '(', '<', '@', 'this.']
    }
  };

  // After the server has started the client sends an initilize request. The server receives
  // in the passed params the rootPath of the workspace plus the client capabilites.
  private onInitialize({ rootUri, rootPath }: InitializeParams): InitializeResult {
    rootPath = rootUri ? uriToFilePath(rootUri) : rootPath;
    if (!rootPath) {
      return { capabilities: {} };
    }

    log(`Initializing Ember Language Server at ${rootPath}`);

    this.projectRoots.initialize(rootPath, this);

    // this.setStatusText('Initialized');

    return {
      capabilities: Object.assign({}, this.capabilities, {
        textDocumentSync: this.documents.syncKind
      })
    };
  }

  private onDidChangeContent(change: any) {
    // this.setStatusText('did-change');
    this.templateLinter.lint(change.document);
  }

  private onDidChangeWatchedFiles() {
    // here be dragons
  }

  private async onReference(params: ReferenceParams): Promise<Location[]> {
    return await this.referenceProvider.provideReferences(params);
  }

  private async onCompletion(textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[]> {
    const completionItems = [];

    try {
      const [templateCompletions, scriptCompletions] = await Promise.all([
        await this.templateCompletionProvider.provideCompletions(textDocumentPosition),
        await this.scriptCompletionProvider.provideCompletions(textDocumentPosition)
      ]);
      completionItems.push(...templateCompletions, ...scriptCompletions);
    } catch (e) {
      log('onCompletion', textDocumentPosition, e, e.toString());
    }

    // this.setStatusText('Running');
    return completionItems;
  }

  // public setStatusText(text: string) {
  // this.connection.sendNotification('els.setStatusBarText', [text]);
  // }

  private onDocumentSymbol(params: DocumentSymbolParams): SymbolInformation[] {
    let uri = params.textDocument.uri;
    let filePath = uriToFilePath(uri);
    if (!filePath) {
      return [];
    }

    let extension = path.extname(filePath);

    let providers = this.documentSymbolProviders.filter((provider) => provider.extensions.indexOf(extension) !== -1);

    if (providers.length === 0) return [];

    let content = fs.readFileSync(filePath, 'utf-8');

    return providers.map((providers) => providers.process(content)).reduce((a, b) => a.concat(b), []);
  }
}
