const fetch = require('node-fetch');
const semver = require('semver');
const fs = require('fs-extra');
const cp = require('child_process');
const util = require('util');
const gunzipMaybe = require('gunzip-maybe');
const Progress = require('progress');
const tarFs = require('tar-fs');
const tar = require('tar-stream');
const path = require('path');

const exec = util.promisify(cp.exec);

function getFileName(entryName, virtualPath) {
  parsedEntryName = entryName.replace(/^\/+/, '');

  for (let t = 0; t < virtualPath; ++t) {
    const index = entryName.indexOf('/');

    if (index === -1) {
      return null;
    }

    entryName = entryName.substr(index + 1);
  }

  return entryName;
}

async function readFileFromArchive(fileName, buffer, { virtualPath = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const extractor = tar.extract();

    extractor.on('entry', (header, stream, next) => {
      if (getFileName(header.name, virtualPath) === fileName) {
        const buffers = [];

        stream.on('data', (data) => {
          buffers.push(data);
        });

        stream.on('error', (error) => {
          reject(error);
        });

        stream.on('end', () => {
          resolve(Buffer.concat(buffers));
        });
      } else {
        stream.on('end', () => {
          next();
        });
      }

      stream.resume();
    });

    extractor.on('error', (error) => {
      reject(error);
    });

    extractor.on('finish', () => {
      reject(new Error(`Couldn't find "${fileName}" inside the archive`));
    });

    const gunzipper = gunzipMaybe();
    gunzipper.pipe(extractor);

    gunzipper.on('error', (error) => {
      reject(error);
    });

    gunzipper.write(buffer);
    gunzipper.end();
  });
}

async function readPackageJsonFromArchive(packageBuffer) {
  return await readFileFromArchive('package.json', packageBuffer, {
    virtualPath: 1,
  });
}

async function extractArchiveTo(
  packageBuffer,
  target,
  { virtualPath = 0 } = {}
) {
  return new Promise((resolve, reject) => {
    function map(header) {
      header.name = getFileName(header.name, virtualPath);
      return header;
    }

    const gunzipper = gunzipMaybe();

    const extractor = tarFs.extract(target, { map });
    gunzipper.pipe(extractor);

    extractor.on('error', (error) => {
      reject(error);
    });

    extractor.on('finish', () => {
      resolve();
    });

    gunzipper.write(packageBuffer);
    gunzipper.end();
  });
}

async function extractNpmArchiveTo(packageBuffer, target) {
  return await extractArchiveTo(packageBuffer, target, { virtualPath: 1 });
}

async function trackProgress(cb) {
  const pace = new Progress(':bar :current/:total :percent (:elapseds)', {
    width: 80,
    total: 1,
  });

  try {
    return await cb(pace);
  } finally {
    if (!pace.complete) {
      pace.update(1);
      pace.terminate();
    }
  }
}

async function linkPackages(pace, { name, reference, dependencies }, cwd) {
  pace.total += 1;

  await getPackageDependencyTree(pace, {
    name,
    reference,
    dependencies,
  });

  // is not root
  if (reference) {
    const packageBuffer = await fetchPackage({ name, reference });
    await extractNpmArchiveTo(packageBuffer, cwd);
  }

  await Promise.all(
    dependencies.map(async ({ name, reference, dependencies }) => {
      const target = `${cwd}/spm_node_modules/${name}`;
      const binTarget = `${cwd}/spm_node_modules/.bin`;

      await linkPackages(pace, { name, reference, dependencies }, target);

      const dependencyPackageJson = require(`${target}/package.json`);

      const bin = dependencyPackageJson.bin || {};
      for (const binName of Object.keys(bin)) {
        const source = path.resolve(target, bin[binName]);
        const dest = `${binTarget}/${binName}`;

        console.log(`bin: ${dest}`);

        await fs.mkdirp(`${cwd}/spm_node_modules/.bin`);
        await fs.symlink(relative(binTarget, source), dest);
      }

      if (dependencyPackageJson.scripts) {
        for (const scriptName of ['preinstall', 'install', 'postinstall']) {
          const script = dependencyPackageJson.scripts[scriptName];

          if (!script) continue;

          await exec(script, {
            cwd: target,
            env: Object.assign({}, process.env, {
              PATH: `${target}/spm_node_modules/.bin:${process.env.PATH}`,
            }),
          });
        }
      }
    })
  );
  pace.tick();
}

const isVolatileDependency = (volatileDependency, available) => {
  const availableReference = available.get(volatileDependency.name);
  if (availableReference === volatileDependency.reference) {
    return false;
  }

  // version check
  if (
    semver.validRange(volatileDependency.reference) &&
    semver.satisfies(availableReference, volatileDependency.reference)
  ) {
    return false;
  }

  return true;
};

async function getPackageDependencyTree(
  pace,
  { name, reference, dependencies },
  available = new Map()
) {
  const promiseDependenciesList = dependencies
    .filter((volatileDependency) =>
      isVolatileDependency(volatileDependency, available)
    )
    .map(async (volatileDependency) => {
      pace.total += 1;

      const pinnedDependency = await getPinnedReference(volatileDependency);
      const subDependencies = await getPackageDependencies(pinnedDependency);

      const subAvailable = new Map(available);
      subAvailable.set(pinnedDependency.name, pinnedDependency.reference);

      pace.tick();

      return await getPackageDependencyTree(
        pace,
        Object.assign({}, pinnedDependency, {
          dependencies: subDependencies,
        }),
        subAvailable
      );
    });

  return {
    name,
    reference,
    dependencies: await Promise.all(promiseDependenciesList),
  };
}

async function getPackageDependencies({ name, reference }) {
  const packageBuffer = await fetchPackage({ name, reference });
  const packageJson = JSON.parse(
    await readPackageJsonFromArchive(packageBuffer)
  );

  const dependencies = packageJson.dependencies || {};

  return Object.keys(dependencies).map((name) => ({
    name,
    reference: dependencies[name],
  }));
}

async function fetchPackage({ name, reference }) {
  if (['/', './', '../'].some((prefix) => reference.startsWith(prefix))) {
    return await fs.readFile(reference);
  }

  if (semver.valid(reference)) {
    return await fetchPackage({
      name,
      reference: `https://registry.yarnpkg.com/${name}/-/${name}-${reference}.tgz`,
    });
  }

  const response = await fetch(reference);

  if (!response.ok) {
    throw new Error(`Couldn't fetch package "${reference}"`);
  }

  return await response.buffer();
}

async function getPinnedReference({ name, reference }) {
  if (semver.validRange(reference) && !semver.valid(reference)) {
    const response = await fetch(`https://registry.yarnpkg.com/${name}`);
    const info = await response.json();

    const versions = Object.keys(info.versions);
    const maxSatisfying = semver.maxSatisfying(versions, reference);

    if (maxSatisfying === null) {
      throw new Error(
        `Couldn't find a version matching "${reference}" for package "${name}"`
      );
    }

    reference = maxSatisfying;
  }
  return { name, reference };
}

function optimizePackageTree({ name, reference, dependencies }) {
  dependencies = dependencies.map((dependency) =>
    optimizePackageTree(dependency)
  );

  for (const hardDependency of dependencies.slice()) {
    for (const subDependency of hardDependency.dependencies.slice()) {
      const availableDependency = dependencies.find(
        (dependency) => dependency.name === subDependency.name
      );

      // If not availableDependency
      if (typeof availableDependency === 'undefined') {
        dependencies.push(subDependency);
      }

      if (
        !availableDependency ||
        availableDependency.reference === subDependency.reference
      ) {
        hardDependency.dependencies.splice(
          hardDependency.dependencies.findIndex(
            (dependency) => dependency.name === subDependency.name
          )
        );
      }
    }
  }
  return { name, reference, dependencies };
}

(async () => {
  const cwd = process.argv[2] || process.cwd();
  const spmJsonPath = path.resolve(cwd, 'spm-package.json'); // TODO: error handling
  const packageJson = require(spmJsonPath);

  const destPath = path.resolve(process.argv[3] || cwd);

  packageJson.dependencies = Object.keys(
    packageJson.dependencies || {}
  ).map((name) => ({ name, reference: packageJson.dependencies[name] }));

  try {
    console.log('Resolving the package tree...');

    const packageTree = await trackProgress((pace) =>
      getPackageDependencyTree(pace, packageJson)
    );

    console.log('Linking the packages on the filesystem...');

    await trackProgress((pace) =>
      linkPackages(pace, optimizePackageTree(packageTree), destPath)
    );
  } catch (error) {
    console.log(error.stack);
    process.exit(1);
  }
})();
