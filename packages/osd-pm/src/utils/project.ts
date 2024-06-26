/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * The OpenSearch Contributors require contributions made to
 * this file be licensed under the Apache-2.0 license or a
 * compatible open source license.
 *
 * Any modifications Copyright OpenSearch Contributors. See
 * GitHub history for details.
 */

/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { existsSync, unlinkSync } from 'fs';
import { resolve, relative } from 'path';
import { inspect } from 'util';

import { CliError } from './errors';
import { log } from './log';
import {
  IPackageDependencies,
  IPackageJson,
  IPackageScripts,
  isLinkDependency,
  readPackageJson,
} from './package_json';
import {
  installInDir,
  patchFile,
  runScriptInPackage,
  runScriptInPackageStreaming,
  yarnWorkspacesInfo,
} from './scripts';
import { buildTargetedPackage, BuildTargets, BuildTargetTypes } from './targeted_build';

interface BuildConfig {
  skip?: boolean;
  intermediateBuildDirectory?: string;
  oss?: boolean;
}

interface CleanConfig {
  extraPatterns?: string[];
}

export class Project {
  public static async fromPath(path: string) {
    const pkgJson = await readPackageJson(path);
    return new Project(pkgJson, path);
  }

  /** parsed package.json */
  public readonly json: IPackageJson;
  /** absolute path to the package.json file in the project */
  public readonly packageJsonLocation: string;
  /** absolute path to the node_modules in the project (might not actually exist) */
  public readonly nodeModulesLocation: string;
  /** absolute path to the target directory in the project (might not actually exist) */
  public readonly targetLocation: string;
  /** absolute path to the directory containing the project */
  public readonly path: string;
  /** the version of the project */
  public readonly version: string;
  /** merged set of dependencies of the project, [name => version range] */
  public readonly allDependencies: IPackageDependencies;
  /** regular dependencies of the project, [name => version range] */
  public readonly productionDependencies: IPackageDependencies;
  /** development dependencies of the project, [name => version range] */
  public readonly devDependencies: IPackageDependencies;
  /** scripts defined in the package.json file for the project [name => body] */
  public readonly scripts: IPackageScripts;
  /** custom definitions for the project, @osd/pm: { key: value } */
  public readonly customDefinitions: IPackageJson;
  /** build targets from the custom definitions, @osd/pm: { node: true, web: true } */
  public readonly buildTargets: BuildTargetTypes[];

  public isWorkspaceRoot = false;
  public isWorkspaceProject = false;

  constructor(packageJson: IPackageJson, projectPath: string) {
    this.json = Object.freeze(packageJson);
    this.path = projectPath;

    this.packageJsonLocation = resolve(this.path, 'package.json');
    this.nodeModulesLocation = resolve(this.path, 'node_modules');
    this.targetLocation = resolve(this.path, 'target');

    this.version = this.json.version;
    this.productionDependencies = this.json.dependencies || {};
    this.devDependencies = this.json.devDependencies || {};
    this.allDependencies = {
      ...this.devDependencies,
      ...this.productionDependencies,
    };
    this.isWorkspaceRoot = this.json.hasOwnProperty('workspaces');

    this.scripts = this.json.scripts || {};
    this.customDefinitions = this.json['@osd/pm'] || {};

    this.buildTargets = [];
    for (const target of BuildTargets) {
      if (this.customDefinitions[target]) this.buildTargets.push(target);
    }
  }

  public get name(): string {
    return this.json.name;
  }

  public ensureValidProjectDependency(project: Project, dependentProjectIsInWorkspace: boolean) {
    const versionInPackageJson = this.allDependencies[project.name];

    let expectedVersionInPackageJson;
    if (dependentProjectIsInWorkspace) {
      expectedVersionInPackageJson = project.json.version;
    } else {
      const relativePathToProject = normalizePath(relative(this.path, project.path));
      expectedVersionInPackageJson = `link:${relativePathToProject}`;
    }

    // No issues!
    if (versionInPackageJson === expectedVersionInPackageJson) {
      return;
    }

    let problemMsg;
    if (isLinkDependency(versionInPackageJson) && dependentProjectIsInWorkspace) {
      problemMsg = `but should be using a workspace`;
    } else if (isLinkDependency(versionInPackageJson)) {
      problemMsg = `using 'link:', but the path is wrong`;
    } else {
      problemMsg = `but it's not using the local package`;
    }

    throw new CliError(
      `[${this.name}] depends on [${project.name}] ${problemMsg}. Update its package.json to the expected value below.`,
      {
        actual: `"${project.name}": "${versionInPackageJson}"`,
        expected: `"${project.name}": "${expectedVersionInPackageJson}"`,
        package: `${this.name} (${this.packageJsonLocation})`,
      }
    );
  }

  public getBuildConfig(): BuildConfig {
    return (this.json.opensearchDashboards && this.json.opensearchDashboards.build) || {};
  }

  /**
   * Returns the directory that should be copied into the OpenSearch Dashboards build artifact.
   * This config can be specified to only include the project's build artifacts
   * instead of everything located in the project directory.
   */
  public getIntermediateBuildDirectory() {
    return resolve(this.path, this.getBuildConfig().intermediateBuildDirectory || '.');
  }

  public getCleanConfig(): CleanConfig {
    return (this.json.opensearchDashboards && this.json.opensearchDashboards.clean) || {};
  }

  public isFlaggedAsDevOnly() {
    return !!(this.json.opensearchDashboards && this.json.opensearchDashboards.devOnly);
  }

  public hasScript(name: string) {
    return name in this.scripts;
  }

  public hasBuildTargets() {
    return this.buildTargets.length > 0;
  }

  public getExecutables(): { [key: string]: string } {
    const raw = this.json.bin;

    if (!raw) {
      return {};
    }

    if (typeof raw === 'string') {
      return {
        [this.name]: resolve(this.path, raw),
      };
    }

    if (typeof raw === 'object') {
      const binsConfig: { [k: string]: string } = {};
      for (const binName of Object.keys(raw)) {
        binsConfig[binName] = resolve(this.path, raw[binName]);
      }
      return binsConfig;
    }

    throw new CliError(
      `[${this.name}] has an invalid "bin" field in its package.json, ` +
        `expected an object or a string`,
      {
        binConfig: inspect(raw),
        package: `${this.name} (${this.packageJsonLocation})`,
      }
    );
  }

  public async runScript(scriptName: string, args: string[] = []) {
    log.info(`Running script [${scriptName}] in [${this.name}]:`);
    return runScriptInPackage(scriptName, args, this);
  }

  public runScriptStreaming(
    scriptName: string,
    options: { args?: string[]; debug?: boolean } = {}
  ) {
    return runScriptInPackageStreaming({
      script: scriptName,
      args: options.args || [],
      pkg: this,
      debug: options.debug,
    });
  }

  public buildForTargets(options: { sourceMaps?: boolean } = {}) {
    if (!this.hasBuildTargets()) {
      log.warning(`There are no build targets defined for [${this.name}]`);
      return false;
    }

    return buildTargetedPackage({
      pkg: this,
      sourceMaps: options.sourceMaps,
    });
  }

  public hasDependencies() {
    return Object.keys(this.allDependencies).length > 0;
  }

  public async installDependencies({ extraArgs }: { extraArgs: string[] }) {
    log.info(`[${this.name}] running yarn`);

    log.write('');
    await installInDir(this.path, extraArgs);
    log.write('');

    await this.removeExtraneousNodeModules();
  }

  /**
   * Install a specific version of a dependency and update the package.json.
   * When a range is not specified, ^<version> is used. The range is then
   * placed in the package.json with intentionally no validation.
   */
  public async installDependencyVersion(
    depName: string,
    version: string,
    dev: boolean = false,
    range?: string
  ) {
    log.info(`[${this.name}] running yarn to install ${depName}@${version}`);

    log.write('');

    const rangeToUse = range || `^${version}`;

    const extraArgs = [`${depName}@${version}`];
    if (dev) extraArgs.push('--dev');

    if (this.isWorkspaceProject) {
      await installInDir(this.path);
    } else {
      await installInDir(this.path, extraArgs, true);
    }

    log.info(`[${this.name}] updating manifests with ${depName}@${rangeToUse}`);

    await patchFile(
      this.packageJsonLocation,
      `"${depName}": "${version}"`,
      `"${depName}": "${rangeToUse}"`
    );
    // The lock-file of workspace packages are symlinked to the root project's and editing the one in the project suffices
    await patchFile(
      resolve(this.path, 'yarn.lock'),
      `${depName}@${version}`,
      `${depName}@${rangeToUse}`
    );

    log.write('');

    await this.removeExtraneousNodeModules();
  }

  /**
   * Yarn workspaces symlinks workspace projects to the root node_modules, even
   * when there is no depenency on the project. This results in unnecicary, and
   * often duplicated code in the build archives.
   */
  public async removeExtraneousNodeModules() {
    // this is only relevant for the root workspace
    if (!this.isWorkspaceRoot) {
      return;
    }

    const workspacesInfo = await yarnWorkspacesInfo(this.path);
    const unusedWorkspaces = new Set(Object.keys(workspacesInfo));

    // check for any cross-project dependency
    for (const name of Object.keys(workspacesInfo)) {
      const workspace = workspacesInfo[name];
      workspace.workspaceDependencies.forEach((w) => unusedWorkspaces.delete(w));
    }

    unusedWorkspaces.forEach((name) => {
      const { dependencies, devDependencies } = this.json;
      const nodeModulesPath = resolve(this.nodeModulesLocation, name);
      const isDependency = dependencies && dependencies.hasOwnProperty(name);
      const isDevDependency = devDependencies && devDependencies.hasOwnProperty(name);

      if (!isDependency && !isDevDependency && existsSync(nodeModulesPath)) {
        log.debug(`No dependency on ${name}, removing link in node_modules`);
        unlinkSync(nodeModulesPath);
      }
    });
  }
}

// We normalize all path separators to `/` in generated files
function normalizePath(path: string) {
  return path.replace(/[\\\/]+/g, '/');
}
