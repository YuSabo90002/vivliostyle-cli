import chalk from 'chalk';
import shelljs from 'shelljs';
import terminalLink from 'terminal-link';
import path from 'upath';
import { URL } from 'url';
import {
  checkBrowserAvailability,
  downloadBrowser,
  launchBrowser,
} from './browser';
import { ManuscriptEntry, MergedConfig } from './config';
import { collectVolumeArgs, runContainer, toContainerPath } from './container';
import { Meta, Payload, TOCItem } from './global-viewer';
import { PdfOutput } from './output';
import { PageSizeData, PostProcess } from './postprocess';
import { prepareServer } from './server';
import {
  checkContainerEnvironment,
  debug,
  logError,
  logInfo,
  logSuccess,
  logUpdate,
  startLogging,
} from './util';

type PuppeteerPage = Resolved<
  ReturnType<Resolved<ReturnType<typeof launchBrowser>>['newPage']>
>;

export type BuildPdfOptions = Omit<MergedConfig, 'outputs' | 'input'> & {
  input: string;
  target: PdfOutput;
};

export async function buildPDFWithContainer(
  option: BuildPdfOptions,
): Promise<string | null> {
  const bypassedOption = {
    ...option,
    input: toContainerPath(option.input),
    target: {
      ...option.target,
      path: toContainerPath(option.target.path),
    },
    entryContextDir: toContainerPath(option.entryContextDir),
    workspaceDir: toContainerPath(option.workspaceDir),
    customStyle: option.customStyle && toContainerPath(option.customStyle),
    customUserStyle:
      option.customUserStyle && toContainerPath(option.customUserStyle),
    sandbox: false,
  };

  await runContainer({
    image: option.image,
    userVolumeArgs: collectVolumeArgs([
      option.workspaceDir,
      path.dirname(option.target.path),
    ]),
    commandArgs: [
      'build',
      '--bypassed-pdf-builder-option',
      JSON.stringify(bypassedOption),
    ],
  });

  return option.target.path;
}

export async function buildPDF({
  input,
  target,
  workspaceDir,
  size,
  customStyle,
  customUserStyle,
  singleDoc,
  executableChromium,
  image,
  sandbox,
  verbose,
  timeout,
  entryContextDir,
  entries,
  httpServer,
  viewer,
}: BuildPdfOptions): Promise<string | null> {
  const isInContainer = checkContainerEnvironment();
  logUpdate(`Launching build environment`);

  const { viewerFullUrl } = await prepareServer({
    input,
    workspaceDir,
    httpServer,
    viewer,
    size,
    style: customStyle,
    userStyle: customUserStyle,
    singleDoc,
    quick: false,
  });
  debug('viewerFullUrl', viewerFullUrl);

  debug(`Executing Chromium path: ${executableChromium}`);
  if (!checkBrowserAvailability(executableChromium)) {
    const puppeteerDir = path.dirname(
      require.resolve('puppeteer-core/package.json'),
    );
    if (!path.relative(puppeteerDir, executableChromium).startsWith('..')) {
      // The browser on puppeteer-core isn't downloaded first time starting CLI so try to download it
      await downloadBrowser();
    } else {
      // executableChromium seems to be specified explicitly
      throw new Error(
        `Cannot find the browser. Please check the executable chromium path: ${executableChromium}`,
      );
    }
  }
  const browser = await launchBrowser({
    headless: 'chrome',
    executablePath: executableChromium,
    args: [
      '--allow-file-access-from-files',
      // FIXME: We seem have to disable sandbox now
      // https://github.com/vivliostyle/vivliostyle-cli/issues/186
      sandbox ? '' : '--no-sandbox',
      viewer ? '' : '--disable-web-security',
      isInContainer ? '--disable-dev-shm-usage' : '',
    ],
    // Workaround that disable timeout of browser startup
    // Confirmed the startup is extremely slow in some CI environment
    // https://github.com/puppeteer/puppeteer/issues/4796
    timeout: 3600000,
  });
  const browserVersion = await browser.version();
  debug(chalk.green('success'), `browserVersion=${browserVersion}`);

  logUpdate('Building pages');

  // FIXME: This issue was reported but all workaround didn't fix
  // https://github.com/puppeteer/puppeteer/issues/4039
  await new Promise((res) => setTimeout(res, 1000));
  const page = await browser.newPage();

  page.on('pageerror', (error) => {
    logError(chalk.red(error.message));
  });

  page.on('console', (msg) => {
    switch (msg.type()) {
      case 'error':
        if (/\/vivliostyle-viewer\.js$/.test(msg.location().url ?? '')) {
          logError(msg.text());
          throw msg.text();
        }
        return;
      case 'debug':
        if (/time slice/.test(msg.text())) {
          return;
        }
        break;
    }
    if (!verbose) {
      return;
    }
    if (msg.type() === 'error') {
      logError(msg.text());
    } else {
      logInfo(msg.text());
    }
  });

  let lastEntry: ManuscriptEntry | undefined;

  function stringifyEntry(entry: ManuscriptEntry) {
    const formattedSourcePath = chalk.bold.cyan(
      path.relative(entryContextDir, entry.source),
    );
    return `${terminalLink(formattedSourcePath, 'file://' + entry.source, {
      fallback: () => formattedSourcePath,
    })} ${entry.title ? chalk.gray(entry.title) : ''}`;
  }

  function handleEntry(response: any) {
    const entry = entries.find((entry): entry is ManuscriptEntry => {
      if (!('source' in entry)) {
        return false;
      }
      const url = new URL(response.url());
      return url.protocol === 'file:'
        ? entry.target === url.pathname
        : path.relative(workspaceDir, entry.target) ===
            url.pathname.substring(1);
    });
    if (entry) {
      if (!lastEntry) {
        lastEntry = entry;
        return logUpdate(stringifyEntry(entry));
      }
      logSuccess(stringifyEntry(lastEntry));
      startLogging(stringifyEntry(entry));
      lastEntry = entry;
    }
  }

  page.on('response', (response) => {
    debug(
      chalk.gray('viewer:response'),
      chalk.green(response.status().toString()),
      response.url(),
    );

    handleEntry(response);

    if (300 > response.status() && 200 <= response.status()) return;
    // file protocol doesn't have status code
    if (response.url().startsWith('file://') && response.ok()) return;

    logError(chalk.red(`${response.status()}`, response.url()));
    startLogging();
    // debug(chalk.red(`${response.status()}`, response.url()));
  });

  let remainTime = timeout;
  const startTime = Date.now();

  await page.setDefaultNavigationTimeout(timeout);
  await page.goto(viewerFullUrl, { waitUntil: 'networkidle0' });
  await page.waitForFunction(
    /* istanbul ignore next */ () => !!window.coreViewer,
  );

  await page.emulateMediaType('print');
  await page.waitForFunction(
    /* istanbul ignore next */
    () => window.coreViewer.readyState === 'complete',
    {
      polling: 1000,
      timeout,
    },
  );

  if (lastEntry) {
    logSuccess(stringifyEntry(lastEntry));
  }

  const pageProgression = await page.evaluate(
    /* istanbul ignore next */ () =>
      document
        .querySelector('#vivliostyle-viewer-viewport')
        ?.getAttribute('data-vivliostyle-page-progression') === 'rtl'
        ? 'rtl'
        : 'ltr',
  );
  const viewerCoreVersion = await page.evaluate(
    /* istanbul ignore next */ () =>
      document
        .querySelector('#vivliostyle-menu_settings .version')
        ?.textContent?.replace(/^.*?: (\d[-+.\w]+).*$/, '$1'),
  );
  const metadata = await loadMetadata(page);
  const toc = await loadTOC(page);
  const pageSizeData = await loadPageSizeData(page);

  remainTime -= Date.now() - startTime;
  if (remainTime <= 0) {
    throw new Error('Typesetting process timed out');
  }
  debug('Remaining timeout:', remainTime);

  logUpdate('Building PDF');

  const pdf = await page.pdf({
    margin: {
      top: 0,
      bottom: 0,
      right: 0,
      left: 0,
    },
    printBackground: true,
    preferCSSPageSize: true,
    timeout: remainTime,
  });

  await browser.close();

  logUpdate('Processing PDF');
  shelljs.mkdir('-p', path.dirname(target.path));

  const post = await PostProcess.load(pdf);
  await post.metadata(metadata, {
    pageProgression,
    browserVersion,
    viewerCoreVersion,
    // If custom viewer is set and its version info is not available,
    // there is no guarantee that the default creator option is correct.
    disableCreatorOption: !!viewer && !viewerCoreVersion,
  });
  await post.toc(toc);
  await post.setPageBoxes(pageSizeData);
  await post.save(target.path, {
    preflight: target.preflight,
    preflightOption: target.preflightOption,
    image,
  });

  return target.path;
}

async function loadMetadata(page: PuppeteerPage): Promise<Meta> {
  return page.evaluate(
    /* istanbul ignore next */ () => window.coreViewer.getMetadata(),
  );
}

// Show and hide the TOC in order to read its contents.
// Chromium needs to see the TOC links in the DOM to add
// the PDF destinations used during postprocessing.
async function loadTOC(page: PuppeteerPage): Promise<TOCItem[]> {
  return page.evaluate(
    /* istanbul ignore next */ () =>
      new Promise<TOCItem[]>((resolve) => {
        function listener(payload: Payload) {
          if (payload.a !== 'toc') {
            return;
          }
          window.coreViewer.removeListener('done', listener);
          window.coreViewer.showTOC(false);
          resolve(window.coreViewer.getTOC());
        }
        window.coreViewer.addListener('done', listener);
        window.coreViewer.showTOC(true);
      }),
  );
}

async function loadPageSizeData(page: PuppeteerPage): Promise<PageSizeData[]> {
  return page.evaluate(
    /* istanbul ignore next */ () => {
      const sizeData: PageSizeData[] = [];
      const pageContainers = document.querySelectorAll(
        '#vivliostyle-viewer-viewport > div > div > div[data-vivliostyle-page-container]',
      ) as NodeListOf<HTMLElement>;

      for (const pageContainer of pageContainers) {
        const bleedBox = pageContainer.querySelector(
          'div[data-vivliostyle-bleed-box]',
        ) as HTMLElement;
        sizeData.push({
          mediaWidth: parseFloat(pageContainer.style.width) * 0.75,
          mediaHeight: parseFloat(pageContainer.style.height) * 0.75,
          bleedOffset: parseFloat(bleedBox?.style.left) * 0.75,
          bleedSize: parseFloat(bleedBox?.style.paddingLeft) * 0.75,
        });
      }
      return sizeData;
    },
  );
}
