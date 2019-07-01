import {Format, Log} from '@diez/cli-core';
import {
  CompilerTargetHandler,
  PrimitiveType,
  PropertyType,
  TargetCompiler,
  TargetComponentProperty,
  TargetComponentSpec,
} from '@diez/compiler';
import {getTempFileName, outputTemplatePackage} from '@diez/storage';
import {ensureDirSync, readFileSync, writeFileSync} from 'fs-extra';
import {compile} from 'handlebars';
import {v4} from 'internal-ip';
import {join} from 'path';
import {joinToKebabCase, sourcesPath} from '../utils';
import {StyleTokens, WebBinding, WebDependency, WebOutput} from './web.api';

/**
 * The root location for source files.
 *
 * @internal
 */
const coreWeb = join(sourcesPath, 'web');

/**
 * Merges a new dependency to the existing set of dependencies.
 *
 * @internal
 */
const mergeDependency = (dependencies: Set<WebDependency>, newDependency: WebDependency) => {
  for (const dependency of dependencies) {
    if (dependency.packageJson.name === newDependency.packageJson.name) {
      // TODO: check for conflicts.
      return;
    }
  }

  dependencies.add(newDependency);
};

/**
 * Returns a qualified CSS URL for a given output and relative path.
 *
 * This method currently assumes that when we do not have a hot URL, static assets will be served in the host
 * application at `/diez`. This detail cannot be guaranteed in every codebase, so further work is required here.
 */
export const getQualifiedCssUrl = (output: WebOutput, relativePath: string) =>
  `url("${output.hotUrl || '/diez'}/${relativePath}")`;

/**
 * A compiler for web targets.
 * @ignore
 */
export class WebCompiler extends TargetCompiler<WebOutput, WebBinding> {
  /**
   * @abstract
   */
  protected async validateOptions () {
    // Noop.
  }

  /**
   * @abstract
   */
  async hostname () {
    return await v4();
  }

  /**
   * @abstract
   */
  get moduleName () {
    return `diez-${this.output.projectName}`;
  }

  /**
   * @abstract
   */
  get hotComponent () {
    return require.resolve('@diez/targets/lib/targets/web.component');
  }

  /**
   * @abstract
   */
  protected collectComponentProperties (
    allProperties: (TargetComponentProperty | undefined)[],
  ): TargetComponentProperty | undefined {
    const properties = allProperties.filter((property) => property !== undefined) as TargetComponentProperty[];
    const reference = properties[0];
    if (!reference) {
      return;
    }

    return {
      type: `${reference.type}[]`,
      initializer: `[${properties.map((property) => property.initializer).join(', ')}]`,
      updatable: false,
    };
  }

  /**
   * @abstract
   */
  protected getInitializer (spec: TargetComponentSpec<TargetComponentProperty>): string {
    const propertyInitializers: string[] = [];
    for (const name in spec.properties) {
      propertyInitializers.push(`${name}: ${spec.properties[name].initializer}`);
    }

    return `new ${spec.componentName}({${propertyInitializers.join(', ')}})`;
  }

  /**
   * @abstract
   */
  protected getPrimitive (type: PropertyType, instance: any): TargetComponentProperty | undefined {
    switch (type) {
      case PrimitiveType.String:
        return {
          type: 'string',
          initializer: `"${instance}"`,
          updatable: false,
        };
      case PrimitiveType.Number:
      case PrimitiveType.Float:
      case PrimitiveType.Int:
        return {
          type: 'number',
          initializer: instance.toString(),
          updatable: false,
        };
      case PrimitiveType.Boolean:
        return {
          type: 'boolean',
          initializer: instance.toString(),
          updatable: false,
        };
      default:
        Log.warning(`Unknown non-component primitive value: ${instance.toString()} with type ${type}`);
        return;
    }
  }

  /**
   * Updates the output based on the contents of the binding.
   */
  private mergeBindingToOutput (binding: WebBinding): void {
    for (const bindingSource of binding.sources) {
      this.output.sources.add(bindingSource);
    }

    if (binding.declarations) {
      for (const declaration of binding.declarations) {
        this.output.declarations.add(declaration);
      }
    }

    if (binding.dependencies) {
      for (const dependency of binding.dependencies) {
        mergeDependency(this.output.dependencies, dependency);
      }
    }
  }

  /**
   * @abstract
   */
  protected createOutput (sdkRoot: string, projectName: string) {
    return {
      sdkRoot,
      projectName,
      processedComponents: new Map(),
      sources: new Set([
        join(coreWeb, 'core', 'Diez.js'),
      ]),
      declarations: new Set([
        join(coreWeb, 'core', 'Diez.d.ts'),
      ]),
      declarationImports: new Set<string>(),
      dependencies: new Set<WebDependency>(),
      assetBindings: new Map(),
      styles: {
        variables: new Map(),
        ruleGroups: new Map(),
        fonts: new Map(),
      },
    };
  }

  /**
   * @abstract
   */
  get staticRoot () {
    return join(this.output.sdkRoot, 'static');
  }

  /**
   * @abstract
   */
  printUsageInstructions () {
    const diez = Format.code('Diez');
    const component = this.program.localComponentNames[0];
    const styleVarName = this.output.styles.variables.keys().next().value;

    Log.info(`Diez package compiled to ${this.output.sdkRoot}.\n`);

    Log.info(`You can depend on ${diez} in ${Format.code('package.json')}:`);
    Log.code(`{
  "dependencies": {
    "${this.moduleName}": "*"
  }
}
`);

    Log.info(`You can use the variables and classes defined by ${diez} in your CSS or Sass styles.
  CSS:  ${Format.code(`rule: var(--${styleVarName});`)}
  Sass: ${Format.code(`rule: \$${styleVarName};`)}\n`);

    Log.info(`You can also use ${diez} with JavaScript to bootstrap any of the components defined in your project.`);

    Log.code(`new Diez(${component}).attach((component) => {
  // ...
});
`);
  }

  /**
   * @abstract
   */
  clear () {
    this.output.sources.clear();
    this.output.declarations.clear();
    this.output.processedComponents.clear();
    this.output.dependencies.clear();
    this.output.assetBindings.clear();
    this.output.styles.variables.clear();
    this.output.styles.ruleGroups.clear();
    this.output.styles.fonts.clear();
  }

  private getStyleTokens (): StyleTokens {
    const numberVariables = new Set<string>();
    for (const [componentName, component] of this.output.processedComponents) {
      for (const [propertyName, property] of Object.entries(component.spec.properties)) {
        const propertyType = property.type.toString();
        if (['number', 'string', 'boolean'].includes(propertyType) && !component.binding) {
          const variableName = joinToKebabCase(componentName, propertyName);
          this.output.styles.variables.set(variableName, property.initializer);

          if (propertyType === 'number') {
            numberVariables.add(variableName);
          }
        }
      }
    }

    return {
      styleVariables: Array.from(this.output.styles.variables).map(([name, value]) => {
        return {name, value, isNumber: numberVariables.has(name)};
      }),
      styleRuleGroups: Array.from(this.output.styles.ruleGroups).map(([name, values]) => {
        return {name, values: Array.from(values)};
      }),
      styleFonts: Array.from(this.output.styles.fonts).map(([key, val]) => Array.from(val)),
    };
  }

  private writeStyleSdk (lang: 'scss' | 'css', tokens: StyleTokens) {
    const template = readFileSync(join(coreWeb, `styles.${lang}.handlebars`)).toString();
    const staticRoot = this.program.hot ? this.hotStaticRoot : this.staticRoot;
    ensureDirSync(staticRoot);
    writeFileSync(join(staticRoot, `styles.${lang}`), compile(template)(tokens));
  }

  writeAssets () {
    super.writeAssets();
    const tokens = this.getStyleTokens();
    this.writeStyleSdk('css', tokens);
    this.writeStyleSdk('scss', tokens);
  }

  async writeSdk () {
    // Pass through to take note of our singletons.
    const singletons = new Set<PropertyType>();
    for (const [type, {instances, binding}] of this.output.processedComponents) {
      // If a binding is provided, it's safe to assume we don't want to treat this object as a singleton, even if it is.
      if (instances.size === 1 && !binding) {
        singletons.add(type);
      }
    }

    const componentTemplate = readFileSync(join(coreWeb, 'js.component.handlebars')).toString();
    const declarationTemplate = readFileSync(join(coreWeb, 'js.declaration.handlebars')).toString();
    for (const [type, {spec, binding}] of this.output.processedComponents) {
      // For each singleton, replace it with its simple constructor.
      for (const property of Object.values(spec.properties)) {
        if (singletons.has(property.type)) {
          property.initializer = `new ${property.type}()`;
        }
      }

      const sourceFilename = getTempFileName();
      this.output.sources.add(sourceFilename);
      writeFileSync(
        sourceFilename,
        compile(componentTemplate)({
          ...spec,
          singleton: spec.public || singletons.has(type),
        }),
      );

      if (binding) {
        this.mergeBindingToOutput(binding);
      }

      if (binding && binding.declarations && binding.declarations.length) {
        continue;
      }

      const declarationFilename = getTempFileName();
      this.output.declarations.add(declarationFilename);
      writeFileSync(
        declarationFilename,
        compile(declarationTemplate)(spec),
      );
    }

    const tokens = {
      moduleName: this.moduleName,
      sdkVersion: this.program.options.sdkVersion,
      dependencies: Array.from(this.output.dependencies),
      sources: Array.from(this.output.sources).map((source) => readFileSync(source).toString()),
      declarations: Array.from(this.output.declarations).map((source) => readFileSync(source).toString()),
      declarationImports: Array.from(this.output.declarationImports),
    };

    this.writeAssets();
    return outputTemplatePackage(join(coreWeb, 'sdk'), this.output.sdkRoot, tokens);
  }
}

/**
 * Handles web target compilation.
 * @ignore
 */
export const webHandler: CompilerTargetHandler = async (program) => {
  return new WebCompiler(program).start();
};
