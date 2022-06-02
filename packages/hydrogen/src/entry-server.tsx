import React, {Suspense} from 'react';
import {
  Logger,
  logServerResponse,
  logCacheControlHeaders,
  logQueryTimings,
  getLoggerWithContext,
} from './utilities/log';
import {getErrorMarkup} from './utilities/error';
import type {
  AssembleHtmlParams,
  RunSsrParams,
  RunRscParams,
  ResolvedHydrogenConfig,
  ResolvedHydrogenRoutes,
} from './types';
import {Html, applyHtmlHead} from './framework/Hydration/Html';
import {ServerComponentResponse} from './framework/Hydration/ServerComponentResponse.server';
import {ServerComponentRequest} from './framework/Hydration/ServerComponentRequest.server';
import {
  preloadRequestCacheData,
  ServerRequestProvider,
} from './foundation/ServerRequestProvider';
import type {ServerResponse, IncomingMessage} from 'http';
import type {PassThrough as PassThroughType} from 'stream';
import {
  getApiRouteFromURL,
  renderApiRoute,
  getApiRoutes,
} from './utilities/apiRoutes';
import {ServerPropsProvider} from './foundation/ServerPropsProvider';
import {isBotUA} from './utilities/bot-ua';
import {setContext, setCache, RuntimeContext} from './framework/runtime';
import {setConfig} from './framework/config';
import {
  ssrRenderToPipeableStream,
  ssrRenderToReadableStream,
  rscRenderToReadableStream,
  createFromReadableStream,
  bufferReadableStream,
} from './streaming.server';
import {RSC_PATHNAME, EVENT_PATHNAME, EVENT_PATHNAME_REGEX} from './constants';
import {stripScriptsFromTemplate} from './utilities/template';
import {setLogger, RenderType} from './utilities/log/log';
import {Analytics} from './foundation/Analytics/Analytics.server';
import {ServerAnalyticsRoute} from './foundation/Analytics/ServerAnalyticsRoute.server';
import {getSyncSessionApi} from './foundation/session/session';
import {parseJSON} from './utilities/parse';
import {htmlEncode} from './utilities';

declare global {
  // This is provided by a Vite plugin
  // and will trigger tree-shaking.
  // eslint-disable-next-line no-var
  var __WORKER__: boolean;
}

const DOCTYPE = '<!DOCTYPE html>';
const CONTENT_TYPE = 'Content-Type';
const HTML_CONTENT_TYPE = 'text/html; charset=UTF-8';

interface RequestHandlerOptions {
  indexTemplate:
    | string
    | ((url: string) => Promise<string | {default: string}>);
  cache?: Cache;
  streamableResponse?: ServerResponse;
  dev?: boolean;
  context?: RuntimeContext;
  nonce?: string;
  buyerIpHeader?: string;
}

export interface RequestHandler {
  (request: Request | IncomingMessage, options: RequestHandlerOptions): Promise<
    Response | undefined
  >;
}

export const renderHydrogen = (App: any) => {
  const handleRequest: RequestHandler = async function (rawRequest, options) {
    const {
      dev,
      nonce,
      cache,
      context,
      buyerIpHeader,
      indexTemplate,
      streamableResponse: nodeResponse,
    } = options;

    const request = new ServerComponentRequest(rawRequest);
    const url = new URL(request.url);

    const {default: inlineHydrogenConfig} = await import(
      // @ts-ignore
      // eslint-disable-next-line node/no-missing-import
      'virtual__hydrogen.config.ts'
    );

    const {default: hydrogenRoutes} = await import(
      // @ts-ignore
      // eslint-disable-next-line node/no-missing-import
      'virtual__hydrogen-routes.server.jsx'
    );

    const hydrogenConfig: ResolvedHydrogenConfig = {
      ...inlineHydrogenConfig,
      routes: hydrogenRoutes,
    };

    request.ctx.hydrogenConfig = hydrogenConfig;
    request.ctx.buyerIpHeader = buyerIpHeader;

    setLogger(hydrogenConfig.logger);
    const log = getLoggerWithContext(request);

    const response = new ServerComponentResponse();
    const sessionApi = hydrogenConfig.session
      ? hydrogenConfig.session(log)
      : undefined;

    request.ctx.session = getSyncSessionApi(request, response, log, sessionApi);

    /**
     * Inject the cache & context into the module loader so we can pull it out for subrequests.
     */
    setCache(cache);
    setContext(context);
    setConfig({dev});

    if (
      url.pathname === EVENT_PATHNAME ||
      EVENT_PATHNAME_REGEX.test(url.pathname)
    ) {
      return ServerAnalyticsRoute(
        request,
        hydrogenConfig.serverAnalyticsConnectors
      );
    }

    const isRSCRequest = url.pathname === RSC_PATHNAME;
    const apiRoute = !isRSCRequest && getApiRoute(url, hydrogenConfig.routes);

    // The API Route might have a default export, making it also a server component
    // If it does, only render the API route if the request method is GET
    if (
      apiRoute &&
      (!apiRoute.hasServerComponent || request.method !== 'GET')
    ) {
      const apiResponse = await renderApiRoute(
        request,
        apiRoute,
        hydrogenConfig.shopify,
        sessionApi
      );

      return apiResponse instanceof Request
        ? handleRequest(apiResponse, options)
        : apiResponse;
    }

    const state: Record<string, any> = isRSCRequest
      ? parseJSON(url.searchParams.get('state') || '{}')
      : {pathname: url.pathname, search: url.search};

    const rsc = runRSC({App, state, log, request, response});

    if (isRSCRequest) {
      const buffered = await bufferReadableStream(rsc.readable.getReader());
      postRequestTasks('rsc', 200, request, response);

      return new Response(buffered, {
        headers: {'cache-control': response.cacheControlHeader},
      });
    }

    if (isBotUA(url, request.headers.get('user-agent'))) {
      response.doNotStream();
    }

    return runSSR({
      log,
      dev,
      rsc,
      nonce,
      state,
      request,
      response,
      nodeResponse,
      template: await getTemplate(indexTemplate, url),
    });
  };

  if (__WORKER__) return handleRequest;

  return ((rawRequest, options) =>
    handleFetchResponseInNode(
      handleRequest(rawRequest, options),
      options.streamableResponse
    )) as RequestHandler;
};

async function getTemplate(
  indexTemplate:
    | string
    | ((url: string) => Promise<string | {default: string}>),
  url: URL
) {
  let template =
    typeof indexTemplate === 'function'
      ? await indexTemplate(url.toString())
      : indexTemplate;

  if (template && typeof template !== 'string') {
    template = template.default;
  }

  return template;
}

function getApiRoute(url: URL, routes: ResolvedHydrogenRoutes) {
  const apiRoutes = getApiRoutes(routes);
  return getApiRouteFromURL(url, apiRoutes);
}

function assembleHtml({
  ssrHtml,
  rscPayload,
  request,
  template,
}: AssembleHtmlParams) {
  let html = applyHtmlHead(ssrHtml, request.ctx.head, template);

  if (rscPayload) {
    html = html.replace(
      '</body>',
      // This must be a function to avoid replacing
      // special patterns like `$1` in `String.replace`.
      () => flightContainer(rscPayload) + '</body>'
    );
  }

  return html;
}

/**
 * Run the SSR/Fizz part of the App. If streaming is disabled,
 * this buffers the output and applies SEO enhancements.
 */
async function runSSR({
  rsc,
  state,
  request,
  response,
  nodeResponse,
  template,
  nonce,
  dev,
  log,
}: RunSsrParams) {
  let ssrDidError: Error | undefined;
  const didError = () => rsc.didError() ?? ssrDidError;

  const [rscReadableForFizz, rscReadableForFlight] = rsc.readable.tee();
  const rscResponse = createFromReadableStream(rscReadableForFizz);
  const RscConsumer = () => rscResponse.readRoot();

  const {noScriptTemplate, bootstrapScripts, bootstrapModules} =
    stripScriptsFromTemplate(template);

  const AppSSR = (
    <Html
      template={response.canStream() ? noScriptTemplate : template}
      hydrogenConfig={request.ctx.hydrogenConfig!}
    >
      <ServerRequestProvider request={request} isRSC={false}>
        <ServerPropsProvider
          initialServerProps={state as any}
          setServerPropsForRsc={() => {}}
        >
          <PreloadQueries request={request}>
            <Suspense fallback={null}>
              <RscConsumer />
            </Suspense>
            <Suspense fallback={null}>
              <Analytics />
            </Suspense>
          </PreloadQueries>
        </ServerPropsProvider>
      </ServerRequestProvider>
    </Html>
  );

  log.trace('start ssr');

  const rscReadable = response.canStream()
    ? new ReadableStream({
        start(controller) {
          log.trace('rsc start chunks');
          const encoder = new TextEncoder();
          bufferReadableStream(rscReadableForFlight.getReader(), (chunk) => {
            const metaTag = flightContainer(chunk);
            controller.enqueue(encoder.encode(metaTag));
          }).then(() => {
            log.trace('rsc finish chunks');
            return controller.close();
          });
        },
      })
    : rscReadableForFlight;

  if (__WORKER__) {
    const encoder = new TextEncoder();
    const transform = new TransformStream();
    const writable = transform.writable.getWriter();
    const responseOptions = {} as ResponseOptions;

    let ssrReadable: Awaited<ReturnType<typeof ssrRenderToReadableStream>>;

    try {
      ssrReadable = await ssrRenderToReadableStream(AppSSR, {
        nonce,
        bootstrapScripts,
        bootstrapModules,
        onError(error) {
          ssrDidError = error;

          if (dev && !writable.closed && !!responseOptions.status) {
            writable.write(getErrorMarkup(error));
          }

          log.error(error);
        },
      });
    } catch (error: unknown) {
      log.error(error);

      return new Response(
        template + (dev ? getErrorMarkup(error as Error) : ''),
        {
          status: 500,
          headers: {[CONTENT_TYPE]: HTML_CONTENT_TYPE},
        }
      );
    }

    if (response.canStream()) log.trace('worker ready to stream');
    ssrReadable.allReady.then(() => log.trace('worker complete ssr'));

    const prepareForStreaming = () => {
      Object.assign(responseOptions, getResponseOptions(response, didError()));

      /**
       * TODO: This assumes `response.cache()` has been called _before_ any
       * queries which might be caught behind Suspense. Clarify this or add
       * additional checks downstream?
       */
      /**
       * TODO: Also add `Vary` headers for `accept-language` and any other keys
       * we want to shard our full-page cache for all Hydrogen storefronts.
       */
      responseOptions.headers.set('cache-control', response.cacheControlHeader);

      if (isRedirect(responseOptions)) {
        return false;
      }

      responseOptions.headers.set(CONTENT_TYPE, HTML_CONTENT_TYPE);
      writable.write(encoder.encode(DOCTYPE));

      const error = didError();
      if (error) {
        // This error was delayed until the headers were properly sent.
        writable.write(encoder.encode(dev ? getErrorMarkup(error) : template));
      }

      return true;
    };

    const shouldFlushBody = response.canStream()
      ? prepareForStreaming()
      : await ssrReadable.allReady.then(prepareForStreaming);

    if (shouldFlushBody) {
      let bufferedSsr = '';
      let isPendingSsrWrite = false;

      const writingSSR = bufferReadableStream(
        ssrReadable.getReader(),
        response.canStream()
          ? (chunk) => {
              bufferedSsr += chunk;

              if (!isPendingSsrWrite) {
                isPendingSsrWrite = true;
                setTimeout(() => {
                  isPendingSsrWrite = false;
                  // React can write fractional chunks synchronously.
                  // This timeout ensures we only write full HTML tags
                  // in order to allow RSC writing concurrently.
                  if (bufferedSsr) {
                    writable.write(encoder.encode(bufferedSsr));
                    bufferedSsr = '';
                  }
                }, 0);
              }
            }
          : undefined
      );

      const writingRSC = bufferReadableStream(
        rscReadable.getReader(),
        response.canStream()
          ? (scriptTag) => writable.write(encoder.encode(scriptTag))
          : undefined
      );

      Promise.all([writingSSR, writingRSC]).then(([ssrHtml, rscPayload]) => {
        if (!response.canStream()) {
          const html = assembleHtml({ssrHtml, rscPayload, request, template});
          writable.write(encoder.encode(html));
        }

        // Last SSR write might be pending, delay closing the writable one tick
        setTimeout(() => writable.close(), 0);
        postRequestTasks('str', responseOptions.status, request, response);
      });
    } else {
      // Redirects do not write body
      writable.close();
      postRequestTasks('str', responseOptions.status, request, response);
    }

    if (response.canStream()) {
      return new Response(transform.readable, responseOptions);
    }

    const bufferedBody = await bufferReadableStream(
      transform.readable.getReader()
    );

    return new Response(bufferedBody, responseOptions);
  } else if (nodeResponse) {
    const {pipe} = ssrRenderToPipeableStream(AppSSR, {
      nonce,
      bootstrapScripts,
      bootstrapModules,
      onShellReady() {
        log.trace('node ready to stream');

        /**
         * TODO: This assumes `response.cache()` has been called _before_ any
         * queries which might be caught behind Suspense. Clarify this or add
         * additional checks downstream?
         */
        writeHeadToNodeResponse(nodeResponse, response, log, didError());

        if (isRedirect(nodeResponse)) {
          // Return redirects early without further rendering/streaming
          return nodeResponse.end();
        }

        if (!response.canStream()) return;

        startWritingToNodeResponse(nodeResponse, dev ? didError() : undefined);

        setTimeout(() => {
          log.trace('node pipe response');
          pipe(nodeResponse);
        }, 0);

        bufferReadableStream(rscReadable.getReader(), (chunk) => {
          log.trace('rsc chunk');
          return nodeResponse.write(chunk);
        });
      },
      async onAllReady() {
        log.trace('node complete ssr');

        if (response.canStream() || nodeResponse.writableEnded) {
          postRequestTasks('str', nodeResponse.statusCode, request, response);

          return;
        }

        writeHeadToNodeResponse(nodeResponse, response, log, didError());

        if (isRedirect(nodeResponse)) {
          // Redirects found after any async code
          return nodeResponse.end();
        }

        const bufferedResponse = await createNodeWriter();
        const bufferedRscPromise = bufferReadableStream(
          rscReadable.getReader()
        );

        let ssrHtml = '';
        bufferedResponse.on('data', (chunk) => (ssrHtml += chunk.toString()));
        bufferedResponse.once('error', (error) => (ssrDidError = error));
        bufferedResponse.once('end', async () => {
          const rscPayload = await bufferedRscPromise;

          const error = didError();
          startWritingToNodeResponse(nodeResponse, dev ? error : undefined);

          let html = template;

          if (!error) {
            html = assembleHtml({ssrHtml, rscPayload, request, template});
            postRequestTasks('ssr', nodeResponse.statusCode, request, response);
          }

          nodeResponse.write(html);
          nodeResponse.end();
        });

        pipe(bufferedResponse);
      },
      onShellError(error: any) {
        log.error(error);

        if (!nodeResponse.writableEnded) {
          writeHeadToNodeResponse(nodeResponse, response, log, error);
          startWritingToNodeResponse(nodeResponse, dev ? error : undefined);

          nodeResponse.write(template);
          nodeResponse.end();
        }
      },
      onError(error: any) {
        ssrDidError = error;

        if (dev && nodeResponse.headersSent) {
          // Calling write would flush headers automatically.
          // Delay this error until headers are properly sent.
          nodeResponse.write(getErrorMarkup(error));
        }

        log.error(error);
      },
    });
  }
}

/**
 * Run the RSC/Flight part of the App
 */
function runRSC({App, state, log, request, response}: RunRscParams) {
  const serverProps = {...state, request, response, log};
  request.ctx.router.serverProps = serverProps;

  const AppRSC = (
    <ServerRequestProvider request={request} isRSC={true}>
      <PreloadQueries request={request}>
        <App {...serverProps} />
        <Suspense fallback={null}>
          <Analytics />
        </Suspense>
      </PreloadQueries>
    </ServerRequestProvider>
  );

  let rscDidError: Error;
  const rscReadable = rscRenderToReadableStream(AppRSC, {
    onError(e) {
      rscDidError = e;
      log.error(e);
    },
  });

  return {readable: rscReadable, didError: () => rscDidError};
}

function PreloadQueries({
  request,
  children,
}: {
  request: ServerComponentRequest;
  children: React.ReactNode;
}) {
  const preloadQueries = request.getPreloadQueries();
  preloadRequestCacheData(request, preloadQueries);

  return <>{children}</>;
}

export default renderHydrogen;

function startWritingToNodeResponse(
  nodeResponse: ServerResponse,
  error?: Error
) {
  if (!nodeResponse.headersSent) {
    nodeResponse.setHeader(CONTENT_TYPE, HTML_CONTENT_TYPE);
    nodeResponse.write(DOCTYPE);
  }

  if (error) {
    // This error was delayed until the headers were properly sent.
    nodeResponse.write(getErrorMarkup(error));
  }
}

type ResponseOptions = {
  headers: Headers;
  status: number;
  statusText?: string;
};

function getResponseOptions(
  {headers, status, customStatus}: ServerComponentResponse,
  error?: Error
) {
  const responseInit = {} as ResponseOptions;

  responseInit.headers = headers;

  if (error) {
    responseInit.status = 500;
  } else {
    responseInit.status = customStatus?.code ?? status ?? 200;

    if (customStatus?.text) {
      responseInit.statusText = customStatus.text;
    }
  }

  return responseInit;
}

function writeHeadToNodeResponse(
  nodeResponse: ServerResponse,
  componentResponse: ServerComponentResponse,
  log: Logger,
  error?: Error
) {
  if (nodeResponse.headersSent) return;
  log.trace('writeHeadToNodeResponse');

  /**
   * TODO: Also add `Vary` headers for `accept-language` and any other keys
   * we want to shard our full-page cache for all Hydrogen storefronts.
   */
  nodeResponse.setHeader('cache-control', componentResponse.cacheControlHeader);

  const {headers, status, statusText} = getResponseOptions(
    componentResponse,
    error
  );

  nodeResponse.statusCode = status;

  if (statusText) {
    nodeResponse.statusMessage = statusText;
  }

  setNodeHeaders(headers, nodeResponse);
}

function isRedirect(response: {status?: number; statusCode?: number}) {
  const status = response.status ?? response.statusCode ?? 0;
  return status >= 300 && status < 400;
}

async function createNodeWriter() {
  // Importing 'stream' directly breaks Vite resolve
  // when building for workers, even though this code
  // does not run in a worker. Looks like tree-shaking
  // kicks in after the import analysis/bundle.
  const streamImport = __WORKER__ ? '' : 'stream';
  const {PassThrough} = await import(streamImport);
  return new PassThrough() as InstanceType<typeof PassThroughType>;
}

function flightContainer(chunk: string) {
  return `<meta data-flight="${htmlEncode(chunk)}" />`;
}

function postRequestTasks(
  type: RenderType,
  status: number,
  request: ServerComponentRequest,
  response: ServerComponentResponse
) {
  logServerResponse(type, request, status);
  logCacheControlHeaders(type, request, response);
  logQueryTimings(type, request);
  request.savePreloadQueries();
}

/**
 * Ensure Node.js environments handle the fetch Response correctly.
 */
function handleFetchResponseInNode(
  fetchResponsePromise: Promise<Response | undefined>,
  nodeResponse?: ServerResponse
) {
  if (nodeResponse) {
    fetchResponsePromise.then((response) => {
      if (!response) return;

      setNodeHeaders(response.headers, nodeResponse);

      nodeResponse.statusCode = response.status;

      if (response.body) {
        nodeResponse.write(response.body);
      }

      nodeResponse.end();
    });
  }

  return fetchResponsePromise;
}

// From fetch Headers to Node Response
function setNodeHeaders(headers: Headers, nodeResponse: ServerResponse) {
  // Headers.raw is only implemented in node-fetch, which is used by Hydrogen in dev and prod.
  // It is the only way for now to access `set-cookie` header as an array.
  // https://github.com/Shopify/hydrogen/issues/1228
  Object.entries((headers as any).raw()).forEach(([key, value]) =>
    nodeResponse.setHeader(key, value as string)
  );
}
