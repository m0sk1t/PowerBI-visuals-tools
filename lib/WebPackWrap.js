"use strict";

const fs = require('fs-extra');
const path = require('path');
const util = require('util');
const lodashCloneDeep = require('lodash.clonedeep');
const exec = util.promisify(require('child_process').exec);

const webpack = require('webpack');
const ExtraWatchWebpackPlugin = require('extra-watch-webpack-plugin');
const FriendlyErrorsWebpackPlugin = require('friendly-errors-webpack-plugin');
const PowerBICustomVisualsWebpackPlugin = require('powerbi-visuals-webpack-plugin');
const Visualizer = require('webpack-bundle-analyzer').BundleAnalyzerPlugin;

const TypescriptCompiler = require('../lib/TypescriptCompiler');
const LessCompiler = require('../lib/LessCompiler');
const ConsoleWriter = require('../lib/ConsoleWriter');
const CertificateTools = require("../lib/CertificateTools");

const config = require('../config.json');


const CWD = process.cwd();
const encoding = "utf8";
const visualPlugin = "visualPlugin.ts";

class WebPackGenerator {

    static async prepareFoldersAndFiles(visualPackage) {
        let tmpFolder = path.join(visualPackage.basePath, ".tmp");
        let dropFolder = path.join(visualPackage.basePath, config.build.dropFolder);
        let packageDropFolder = path.join(visualPackage.basePath, config.package.dropFolder);
        let precompileFolder = path.join(visualPackage.basePath, config.build.precompileFolder);
        let visualPluginFile = path.join(visualPackage.basePath, config.build.precompileFolder, visualPlugin);
        await fs.ensureDir(tmpFolder);
        await fs.ensureDir(dropFolder);
        await fs.ensureDir(packageDropFolder);
        await fs.ensureDir(precompileFolder);
        await fs.createFile(visualPluginFile);
    }

    static loadAPIPackage() {
        try {
            let basePath = require.resolve("powerbi-visuals-api", {
                paths: [CWD]
            });
            return require(basePath);
        } catch (ex) {
            return null;
        }
    }

    async installAPIpackage() {
        let apiVersion = this.pbiviz.apiVersion ? `~${this.pbiviz.apiVersion}` : "latest";
        try {
            ConsoleWriter.info(`Installing API: ${apiVersion}...`);
            let {
                stdout,
                stderr
            } = await exec(`npm install --save powerbi-visuals-api@${apiVersion}`);
            ConsoleWriter.info(stdout);
            ConsoleWriter.error(stderr);
            return true;
        } catch (ex) {
            if (ex.message.indexOf("No matching version found for powerbi-visuals-api") !== -1) {
                throw new Error(`Error: Invalid API version: ${apiVersion}`);
            }
            ConsoleWriter.error(`npm install powerbi-visuals-api@${apiVersion} failed`);
            return false;
        }
    }

    enableOptimization() {
        this.webpackConfig.mode = "production";
        this.webpackConfig.optimization = {
            concatenateModules: false,
            minimize: true
        };
    }

    async configureDevServer(visualPackage, port = 8080) {
        let options = await CertificateTools.resolveCertificate();

        this.webpackConfig.devServer = {
            ...this.webpackConfig.devServer,
            port: port || config.server.port,
            contentBase: path.join(visualPackage.basePath, config.build.dropFolder),
            https: {
                key: options.key,
                cert: options.cert,
                pfx: options.pfx,
                passphrase: options.passphrase
            },
            publicPath: config.server.assetsRoute
        };
    }

    configureVisualPlugin(options, tsconfig, visualPackage) {
        const visualJSFilePath = visualPackage.buildPath(tsconfig.compilerOptions.out || tsconfig.compilerOptions.outDir);
        this.webpackConfig.output.path = path.join(visualPackage.basePath, config.build.dropFolder);
        this.webpackConfig.output.filename = "[name]";
        let visualPluginPath = path.join(CWD, config.build.precompileFolder, visualPlugin);
        this.webpackConfig.plugins.push(
            new webpack.WatchIgnorePlugin([visualPluginPath])
        );
        if (tsconfig.compilerOptions.out) {
            this.webpackConfig.entry = {
                "visual.js": visualJSFilePath
            };
        } else {
            this.webpackConfig.entry["visual.js"] = [visualPluginPath];
            this.webpackConfig.output.library = `${this.pbiviz.visual.guid}${options.devMode ? "_DEBUG" : ""}`;
            this.webpackConfig.output.libraryTarget = 'var';
        }
    }

    async configureCustomVisualsWebpackPlugin(visualPackage, options, tsconfig) {
        let pluginConfiguration = lodashCloneDeep(visualPackage.config);

        if (tsconfig.compilerOptions.outDir) {
            let api = WebPackGenerator.loadAPIPackage(visualPackage);
            // if the powerbi-visual-api package wasn't installed
            // install the powerbi-visual-api, with version from apiVersion in pbiviz.json
            // or the latest version the API if apiVersion is absent in pbiviz.json
            if (api === null || (typeof this.pbiviz.apiVersion !== "undefined" && this.pbiviz.apiVersion != api.version)) {
                await this.installAPIpackage();
                api = WebPackGenerator.loadAPIPackage(visualPackage);
            }
            pluginConfiguration.apiVersion = api.version;
            pluginConfiguration.capabilitiesSchema = api.schemas.capabilities;
            pluginConfiguration.pbivizSchema = api.schemas.pbiviz;
            pluginConfiguration.stringResourcesSchema = api.schemas.stringResources;
            pluginConfiguration.dependenciesSchema = api.schemas.dependencies;
        } else {
            pluginConfiguration.schemaLocation = path.join(CWD, '.api', 'v' + this.pbiviz.apiVersion);
            pluginConfiguration.externalJS = [path.join(visualPackage.basePath, config.build.precompileFolder, "externalJS.js")];
            pluginConfiguration.cssStyles = path.join(visualPackage.basePath, config.build.dropFolder, config.build.css);
            pluginConfiguration.generatePlugin = false;
        }

        pluginConfiguration.customVisualID = `CustomVisual_${this.pbiviz.visual.guid}`.replace(/[^\w\s]/gi, '');
        pluginConfiguration.devMode = (typeof options.devMode === "undefined") ? true : options.devMode;
        pluginConfiguration.generatePbiviz = options.generatePbiviz;
        pluginConfiguration.generateResources = options.generateResources;
        pluginConfiguration.minifyJS = options.minifyJS;
        pluginConfiguration.dependencies = this.pbiviz.dependencies;
        pluginConfiguration.modules = typeof tsconfig.compilerOptions.outDir !== "undefined";
        pluginConfiguration.visualSourceLocation = path.posix.relative(config.build.precompileFolder, tsconfig.files[0]).replace(/(\.ts)x|\.ts/, "");
        pluginConfiguration.pluginLocation = path.join(config.build.precompileFolder, "visualPlugin.ts");
        pluginConfiguration.compression = options.compression;
        return pluginConfiguration;
    }

    async appendPlugins(options, visualPackage, tsconfig) {
        let pluginConfiguration = await this.configureCustomVisualsWebpackPlugin(visualPackage, options, tsconfig);

        let statsFilename = config.build.stats.split("/").pop();
        let statsLocation = config.build.stats.split("/").slice(0, -1).join(path.sep);
        statsFilename = statsFilename.split(".").slice(0, -1).join(".");
        statsFilename = `${statsFilename}.${options.devMode ? "dev" : "prod"}.html`;

        this.webpackConfig.plugins.push(
            new Visualizer({
                reportFilename: path.join(statsLocation, statsFilename),
                openAnalyzer: false,
                analyzerMode: `static`
            }),
            new PowerBICustomVisualsWebpackPlugin(pluginConfiguration),
            new ExtraWatchWebpackPlugin({
                files: [visualPackage.buildPath(this.pbiviz.capabilities)]
            }),
            new FriendlyErrorsWebpackPlugin(),
            new webpack.ProvidePlugin({
                window: 'realWindow',
                define: 'fakeDefine',
                powerbi: 'globalPowerbi'
            })
        );
    }

    setTarget({
        fast = false
    }) {
        let tsOptions = {};
        if (fast) {
            tsOptions = {
                transpileOnly: false,
                experimentalWatchApi: false
            };
        }
        this.webpackConfig.module.rules.push({
            test: /(\.ts)x?$/,
            use: [
                {
                    loader: require.resolve('ts-loader'),
                    options: tsOptions
                }
            ]
        });
    }

    async prepareWebPackConfig(visualPackage, options, tsconfig) {
        this.webpackConfig = require('./webpack.config');
        if (options.minifyJS) {
            this.enableOptimization();
        }
        await this.appendPlugins(options, visualPackage, tsconfig);
        await this.configureDevServer(visualPackage, options.devServerPort);
        await this.configureVisualPlugin(options, tsconfig, visualPackage);
        this.setTarget({
            target: options.target,
            fast: options.fast,
            oldProject: options.oldProject
        });

        return this.webpackConfig;
    }

    async assemblyExternalJSFiles(visualPackage) {
        let externalJSFilesContent = "";
        let externalJSFilesPath = path.join(visualPackage.basePath, config.build.precompileFolder, "externalJS.js");
        await fs.writeFile(
            externalJSFilesPath,
            externalJSFilesContent, {
            encoding: encoding
        });

        return externalJSFilesPath;
    }

    async applyWebpackConfig(visualPackage, options = {
        devMode: false,
        generateResources: false,
        generatePbiviz: false,
        minifyJS: true,
        minify: true,
        pbivizFile: 'pbiviz.json',
        tsconfigFile: 'tsconfig.json',
        devServerPort: 8080,
        fast: false,
        compression: 0,
        oldProject: false
    }) {
        const { tsconfigFile, pbivizFile } = options;
        const tsconfigPath = visualPackage.buildPath(tsconfigFile);
        const pbivizJsonPath = visualPackage.buildPath(pbivizFile);

        const tsconfig = require(tsconfigPath);
        this.pbiviz = require(pbivizJsonPath);

        const capabliliesPath = this.pbiviz.capabilities;
        visualPackage.config.capabilities = capabliliesPath;

        const dependenciesPath = this.pbiviz.dependencies && path.join(CWD, this.pbiviz.dependencies);
        const dependenciesFile = fs.existsSync(dependenciesPath) && require(dependenciesPath);
        visualPackage.config.dependencies = dependenciesFile || {};

        await WebPackGenerator.prepareFoldersAndFiles(visualPackage);

        let webpackConfig;
        // new style
        let oldProject;
        if (tsconfig.compilerOptions.outDir) {
            options.oldProject = false;
            oldProject = false;
            // check apiVersion in package.json and installed version
            webpackConfig = await this.prepareWebPackConfig(visualPackage, options, tsconfig);
            // old style
        } else {
            options.oldProject = true;
            oldProject = true;
            ConsoleWriter.warn("For better development experience, we strongly recommend converting the visual to es2015 modules");
            ConsoleWriter.warn("https://microsoft.github.io/PowerBI-visuals/docs/latest/how-to-guide/migrating-to-powerbi-visuals-tools-3-0");
            let pluginDropPath = await TypescriptCompiler
                .createPlugin(
                    visualPackage,
                    `${this.pbiviz.visual.guid}${options.devMode ? "_DEBUG" : ""}`
                );
            tsconfig.files.push(pluginDropPath);

            await TypescriptCompiler.runWatcher(tsconfig.files, tsconfig.compilerOptions, !options.devMode, visualPackage);
            await TypescriptCompiler.concatExternalJS(visualPackage);
            await this.assemblyExternalJSFiles(visualPackage, options.minifyJS, tsconfig.compilerOptions.out);
            await TypescriptCompiler.appendExportPowerBINameSpace(visualPackage, tsconfig.compilerOptions);
            await TypescriptCompiler.injectGlobalizeNameSpace(visualPackage, tsconfig.compilerOptions);
            await LessCompiler.build(visualPackage, options);
            // eslint-disable-next-line require-atomic-updates
            options.target = "es6"; // disable babel for old projects
            webpackConfig = await this.prepareWebPackConfig(visualPackage, options, tsconfig);
        }
        return {
            webpackConfig,
            oldProject
        };
    }
}

module.exports = WebPackGenerator;
