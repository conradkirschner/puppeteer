const {helper, assert} = require('./helper');
const {TimeoutError} = require('./Errors');
const fs = require('fs');
const util = require('util');
const EventEmitter = require('events');
const {Events} = require('./Events');
const {ExecutionContext} = require('./ExecutionContext');
const {NavigationWatchdog, NextNavigationWatchdog} = require('./NavigationWatchdog');

const readFileAsync = util.promisify(fs.readFile);

class FrameManager extends EventEmitter {
  /**
   * @param {PageSession} session
   * @param {Page} page
   */
  constructor(session, page, networkManager, timeoutSettings) {
    super();
    this._session = session;
    this._page = page;
    this._networkManager = networkManager;
    this._timeoutSettings = timeoutSettings;
    this._mainFrame = null;
    this._frames = new Map();
    this._eventListeners = [
      helper.addEventListener(this._session, 'Page.eventFired', this._onEventFired.bind(this)),
      helper.addEventListener(this._session, 'Page.frameAttached', this._onFrameAttached.bind(this)),
      helper.addEventListener(this._session, 'Page.frameDetached', this._onFrameDetached.bind(this)),
      helper.addEventListener(this._session, 'Page.navigationCommitted', this._onNavigationCommitted.bind(this)),
      helper.addEventListener(this._session, 'Page.sameDocumentNavigation', this._onSameDocumentNavigation.bind(this)),
    ];
  }

  frame(frameId) {
    return this._frames.get(frameId);
  }

  mainFrame() {
    return this._mainFrame;
  }

  frames() {
    /** @type {!Array<!Frame>} */
    let frames = [];
    collect(this._mainFrame);
    return frames;

    function collect(frame) {
      frames.push(frame);
      for (const subframe of frame._children)
        collect(subframe);
    }
  }

  _onNavigationCommitted(params) {
    const frame = this._frames.get(params.frameId);
    frame._navigated(params.url, params.name, params.navigationId);
    frame._DOMContentLoadedFired = false;
    frame._loadFired = false;
    this.emit(Events.FrameManager.FrameNavigated, frame);
  }

  _onSameDocumentNavigation(params) {
    const frame = this._frames.get(params.frameId);
    frame._url = params.url;
    this.emit(Events.FrameManager.FrameNavigated, frame);
  }

  _onFrameAttached(params) {
    const frame = new Frame(this._session, this, this._networkManager, this._page, params.frameId, this._timeoutSettings);
    const parentFrame = this._frames.get(params.parentFrameId) || null;
    if (parentFrame) {
      frame._parentFrame = parentFrame;
      parentFrame._children.add(frame);
    } else {
      assert(!this._mainFrame, 'INTERNAL ERROR: re-attaching main frame!');
      this._mainFrame = frame;
    }
    this._frames.set(params.frameId, frame);
    this.emit(Events.FrameManager.FrameAttached, frame);
  }

  _onFrameDetached(params) {
    const frame = this._frames.get(params.frameId);
    this._frames.delete(params.frameId);
    frame._detach();
    this.emit(Events.FrameManager.FrameDetached, frame);
  }

  _onEventFired({frameId, name}) {
    const frame = this._frames.get(frameId);
    frame._firedEvents.add(name.toLowerCase());
    if (frame === this._mainFrame) {
      if (name === 'load')
        this.emit(Events.FrameManager.Load);
      else if (name === 'DOMContentLoaded')
        this.emit(Events.FrameManager.DOMContentLoaded);
    }
  }

  dispose() {
    helper.removeEventListeners(this._eventListeners);
  }
}

class Frame {
  /**
   * @param {*} session
   * @param {!Page} page
   * @param {string} frameId
   */
  constructor(session, frameManager, networkManager, page, frameId, timeoutSettings) {
    this._session = session;
    this._page = page;
    this._frameManager = frameManager;
    this._networkManager = networkManager;
    this._timeoutSettings = timeoutSettings;
    this._frameId = frameId;
    /** @type {?Frame} */
    this._parentFrame = null;
    this._url = '';
    this._name = '';
    /** @type {!Set<!Frame>} */
    this._children = new Set();
    this._isDetached = false;

    this._firedEvents = new Set();

    /** @type {!Set<!WaitTask>} */
    this._waitTasks = new Set();
    this._documentPromise = null;

    this._executionContext = new ExecutionContext(this._session, this, this._frameId);
  }

  async executionContext() {
    return this._executionContext;
  }

  /**
   * @param {!{timeout?: number, waitUntil?: string|!Array<string>}} options
   */
  async waitForNavigation(options = {}) {
    const {
      timeout = this._timeoutSettings.navigationTimeout(),
      waitUntil = ['load'],
    } = options;
    const normalizedWaitUntil = normalizeWaitUntil(waitUntil);

    const timeoutError = new TimeoutError('Navigation Timeout Exceeded: ' + timeout + 'ms');
    let timeoutCallback;
    const timeoutPromise = new Promise(resolve => timeoutCallback = resolve.bind(null, timeoutError));
    const timeoutId = timeout ? setTimeout(timeoutCallback, timeout) : null;

    const nextNavigationDog = new NextNavigationWatchdog(this._session, this);
    const error1 = await Promise.race([
      nextNavigationDog.promise(),
      timeoutPromise,
    ]);
    nextNavigationDog.dispose();

    // If timeout happened first - throw.
    if (error1) {
      clearTimeout(timeoutId);
      throw error1;
    }

    const {navigationId, url} = nextNavigationDog.navigation();

    if (!navigationId) {
      // Same document navigation happened.
      clearTimeout(timeoutId);
      return null;
    }

    const watchDog = new NavigationWatchdog(this._session, this, this._networkManager, navigationId, url, normalizedWaitUntil);
    const error = await Promise.race([
      timeoutPromise,
      watchDog.promise(),
    ]);
    watchDog.dispose();
    clearTimeout(timeoutId);
    if (error)
      throw error;
    return watchDog.navigationResponse();
  }

  /**
   * @param {string} url
   * @param {!{timeout?: number, waitUntil?: string|!Array<string>}} options
   */
  async goto(url, options = {}) {
    const {
      timeout = this._timeoutSettings.navigationTimeout(),
      waitUntil = ['load'],
    } = options;
    const normalizedWaitUntil = normalizeWaitUntil(waitUntil);
    const {navigationId} = await this._session.send('Page.navigate', {
      frameId: this._frameId,
      url,
    });
    if (!navigationId)
      return;

    const timeoutError = new TimeoutError('Navigation Timeout Exceeded: ' + timeout + 'ms');
    let timeoutCallback;
    const timeoutPromise = new Promise(resolve => timeoutCallback = resolve.bind(null, timeoutError));
    const timeoutId = timeout ? setTimeout(timeoutCallback, timeout) : null;

    const watchDog = new NavigationWatchdog(this._session, this, this._networkManager, navigationId, url, normalizedWaitUntil);
    const error = await Promise.race([
      timeoutPromise,
      watchDog.promise(),
    ]);
    watchDog.dispose();
    clearTimeout(timeoutId);
    if (error)
      throw error;
    return watchDog.navigationResponse();
  }

  /**
   * @param {string} selector
   * @param {!{delay?: number, button?: string, clickCount?: number}=} options
   */
  async click(selector, options = {}) {
    const handle = await this.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.click(options);
    await handle.dispose();
  }

  /**
   * @param {string} selector
   * @param {string} text
   * @param {{delay: (number|undefined)}=} options
   */
  async type(selector, text, options) {
    const handle = await this.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.type(text, options);
    await handle.dispose();
  }

  /**
   * @param {string} selector
   */
  async focus(selector) {
    const handle = await this.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.focus();
    await handle.dispose();
  }

  /**
   * @param {string} selector
   */
  async hover(selector) {
    const handle = await this.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.hover();
    await handle.dispose();
  }

  _detach() {
    this._parentFrame._children.delete(this);
    this._parentFrame = null;
    this._isDetached = true;
    for (const waitTask of this._waitTasks)
      waitTask.terminate(new Error('waitForFunction failed: frame got detached.'));
  }

  _navigated(url, name, navigationId) {
    this._url = url;
    this._name = name;
    this._lastCommittedNavigationId = navigationId;
    this._documentPromise = null;
    this._firedEvents.clear();
  }

  /**
  * @param {string} selector
  * @param {!Array<string>} values
  * @return {!Promise<!Array<string>>}
  */
  select(selector, ...values) {
    for (const value of values)
      assert(helper.isString(value), 'Values must be strings. Found value "' + value + '" of type "' + (typeof value) + '"');
    return this.$eval(selector, (element, values) => {
      if (element.nodeName.toLowerCase() !== 'select')
        throw new Error('Element is not a <select> element.');

      const options = Array.from(element.options);
      element.value = undefined;
      for (const option of options) {
        option.selected = values.includes(option.value);
        if (option.selected && !element.multiple)
          break;
      }
      element.dispatchEvent(new Event('input', { 'bubbles': true }));
      element.dispatchEvent(new Event('change', { 'bubbles': true }));
      return options.filter(option => option.selected).map(option => option.value);
    }, values);
  }

  /**
   * @param {(string|number|Function)} selectorOrFunctionOrTimeout
   * @param {!{polling?: string|number, timeout?: number, visible?: boolean, hidden?: boolean}=} options
   * @param {!Array<*>} args
   * @return {!Promise<!JSHandle>}
   */
  waitFor(selectorOrFunctionOrTimeout, options, ...args) {
    const xPathPattern = '//';

    if (helper.isString(selectorOrFunctionOrTimeout)) {
      const string = /** @type {string} */ (selectorOrFunctionOrTimeout);
      if (string.startsWith(xPathPattern))
        return this.waitForXPath(string, options);
      return this.waitForSelector(string, options);
    }
    if (helper.isNumber(selectorOrFunctionOrTimeout))
      return new Promise(fulfill => setTimeout(fulfill, /** @type {number} */ (selectorOrFunctionOrTimeout)));
    if (typeof selectorOrFunctionOrTimeout === 'function')
      return this.waitForFunction(selectorOrFunctionOrTimeout, options, ...args);
    return Promise.reject(new Error('Unsupported target type: ' + (typeof selectorOrFunctionOrTimeout)));
  }

  /**
   * @param {Function|string} pageFunction
   * @param {!{polling?: string|number, timeout?: number}=} options
   * @return {!Promise<!JSHandle>}
   */
  waitForFunction(pageFunction, options = {}, ...args) {
    const {
      polling = 'raf',
      timeout = this._timeoutSettings.timeout(),
    } = options;
    return new WaitTask(this, pageFunction, 'function', polling, timeout, ...args).promise;
  }

  /**
   * @param {string} selector
   * @param {!{timeout?: number, visible?: boolean, hidden?: boolean}=} options
   * @return {!Promise<!ElementHandle>}
   */
  waitForSelector(selector, options) {
    return this._waitForSelectorOrXPath(selector, false, options);
  }

  /**
   * @param {string} xpath
   * @param {!{timeout?: number, visible?: boolean, hidden?: boolean}=} options
   * @return {!Promise<!ElementHandle>}
   */
  waitForXPath(xpath, options) {
    return this._waitForSelectorOrXPath(xpath, true, options);
  }

  /**
   * @param {string} selectorOrXPath
   * @param {boolean} isXPath
   * @param {!{timeout?: number, visible?: boolean, hidden?: boolean}=} options
   * @return {!Promise<!ElementHandle>}
   */
  _waitForSelectorOrXPath(selectorOrXPath, isXPath, options = {}) {
    const {
      visible: waitForVisible = false,
      hidden: waitForHidden = false,
      timeout = this._timeoutSettings.timeout(),
    } = options;
    const polling = waitForVisible || waitForHidden ? 'raf' : 'mutation';
    const title = `${isXPath ? 'XPath' : 'selector'} "${selectorOrXPath}"${waitForHidden ? ' to be hidden' : ''}`;
    return new WaitTask(this, predicate, title, polling, timeout, selectorOrXPath, isXPath, waitForVisible, waitForHidden).promise;

    /**
     * @param {string} selectorOrXPath
     * @param {boolean} isXPath
     * @param {boolean} waitForVisible
     * @param {boolean} waitForHidden
     * @return {?Node|boolean}
     */
    function predicate(selectorOrXPath, isXPath, waitForVisible, waitForHidden) {
      const node = isXPath
        ? document.evaluate(selectorOrXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
        : document.querySelector(selectorOrXPath);
      if (!node)
        return waitForHidden;
      if (!waitForVisible && !waitForHidden)
        return node;
      const element = /** @type {Element} */ (node.nodeType === Node.TEXT_NODE ? node.parentElement : node);

      const style = window.getComputedStyle(element);
      const isVisible = style && style.visibility !== 'hidden' && hasVisibleBoundingBox();
      const success = (waitForVisible === isVisible || waitForHidden === !isVisible);
      return success ? node : null;

      /**
       * @return {boolean}
       */
      function hasVisibleBoundingBox() {
        const rect = element.getBoundingClientRect();
        return !!(rect.top || rect.bottom || rect.width || rect.height);
      }
    }
  }

  /**
   * @return {!Promise<String>}
   */
  async content() {
    return await this.evaluate(() => {
      let retVal = '';
      if (document.doctype)
        retVal = new XMLSerializer().serializeToString(document.doctype);
      if (document.documentElement)
        retVal += document.documentElement.outerHTML;
      return retVal;
    });
  }

  /**
   * @param {string} html
   */
  async setContent(html) {
    await this.evaluate(html => {
      document.open();
      document.write(html);
      document.close();
    }, html);
  }

  async evaluate(pageFunction, ...args) {
    return this._executionContext.evaluate(pageFunction, ...args);
  }

  _document() {
    if (!this._documentPromise)
      this._documentPromise = this.evaluateHandle('document').then(handle => handle.asElement());
    return this._documentPromise;
  }

  /**
   * @param {string} selector
   * @return {!Promise<?ElementHandle>}
   */
  async $(selector) {
    const document = await this._document();
    return document.$(selector);
  }

  /**
   * @param {string} selector
   * @return {!Promise<!Array<!ElementHandle>>}
   */
  async $$(selector) {
    const document = await this._document();
    return document.$$(selector);
  }

  /**
   * @param {string} selector
   * @param {Function|String} pageFunction
   * @param {!Array<*>} args
   * @return {!Promise<(!Object|undefined)>}
   */
  async $eval(selector, pageFunction, ...args) {
    const document = await this._document();
    return document.$eval(selector, pageFunction, ...args);
  }

  /**
   * @param {string} selector
   * @param {Function|String} pageFunction
   * @param {!Array<*>} args
   * @return {!Promise<(!Object|undefined)>}
   */
  async $$eval(selector, pageFunction, ...args) {
    const document = await this._document();
    return document.$$eval(selector, pageFunction, ...args);
  }

  /**
   * @param {string} expression
   * @return {!Promise<!Array<!ElementHandle>>}
   */
  async $x(expression) {
    const document = await this._document();
    return document.$x(expression);
  }

  async evaluateHandle(pageFunction, ...args) {
    return this._executionContext.evaluateHandle(pageFunction, ...args);
  }

  /**
   * @param {!{content?: string, path?: string, type?: string, url?: string}} options
   * @return {!Promise<!ElementHandle>}
   */
  async addScriptTag(options) {
    if (typeof options.url === 'string') {
      const url = options.url;
      try {
        return (await this.evaluateHandle(addScriptUrl, url, options.type)).asElement();
      } catch (error) {
        throw new Error(`Loading script from ${url} failed`);
      }
    }

    if (typeof options.path === 'string') {
      let contents = await readFileAsync(options.path, 'utf8');
      contents += '//# sourceURL=' + options.path.replace(/\n/g, '');
      return (await this.evaluateHandle(addScriptContent, contents, options.type)).asElement();
    }

    if (typeof options.content === 'string') {
      return (await this.evaluateHandle(addScriptContent, options.content, options.type)).asElement();
    }

    throw new Error('Provide an object with a `url`, `path` or `content` property');

    /**
     * @param {string} url
     * @param {string} type
     * @return {!Promise<!HTMLElement>}
     */
    async function addScriptUrl(url, type) {
      const script = document.createElement('script');
      script.src = url;
      if (type)
        script.type = type;
      const promise = new Promise((res, rej) => {
        script.onload = res;
        script.onerror = rej;
      });
      document.head.appendChild(script);
      await promise;
      return script;
    }

    /**
     * @param {string} content
     * @param {string} type
     * @return {!HTMLElement}
     */
    function addScriptContent(content, type = 'text/javascript') {
      const script = document.createElement('script');
      script.type = type;
      script.text = content;
      let error = null;
      script.onerror = e => error = e;
      document.head.appendChild(script);
      if (error)
        throw error;
      return script;
    }
  }

  /**
   * @param {!{content?: string, path?: string, url?: string}} options
   * @return {!Promise<!ElementHandle>}
   */
  async addStyleTag(options) {
    if (typeof options.url === 'string') {
      const url = options.url;
      try {
        return (await this.evaluateHandle(addStyleUrl, url)).asElement();
      } catch (error) {
        throw new Error(`Loading style from ${url} failed`);
      }
    }

    if (typeof options.path === 'string') {
      let contents = await readFileAsync(options.path, 'utf8');
      contents += '/*# sourceURL=' + options.path.replace(/\n/g, '') + '*/';
      return (await this.evaluateHandle(addStyleContent, contents)).asElement();
    }

    if (typeof options.content === 'string') {
      return (await this.evaluateHandle(addStyleContent, options.content)).asElement();
    }

    throw new Error('Provide an object with a `url`, `path` or `content` property');

    /**
     * @param {string} url
     * @return {!Promise<!HTMLElement>}
     */
    async function addStyleUrl(url) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      const promise = new Promise((res, rej) => {
        link.onload = res;
        link.onerror = rej;
      });
      document.head.appendChild(link);
      await promise;
      return link;
    }

    /**
     * @param {string} content
     * @return {!Promise<!HTMLElement>}
     */
    async function addStyleContent(content) {
      const style = document.createElement('style');
      style.type = 'text/css';
      style.appendChild(document.createTextNode(content));
      const promise = new Promise((res, rej) => {
        style.onload = res;
        style.onerror = rej;
      });
      document.head.appendChild(style);
      await promise;
      return style;
    }
  }

  /**
   * @return {!Promise<string>}
   */
  async title() {
    return this.evaluate(() => document.title);
  }

  name() {
    return this._name;
  }

  isDetached() {
    return this._isDetached;
  }

  childFrames() {
    return Array.from(this._children);
  }

  url() {
    return this._url;
  }

  parentFrame() {
    return this._parentFrame;
  }
}

/**
 * @internal
 */
class WaitTask {
  /**
   * @param {!Frame} frame
   * @param {Function|string} predicateBody
   * @param {string|number} polling
   * @param {number} timeout
   * @param {!Array<*>} args
   */
  constructor(frame, predicateBody, title, polling, timeout, ...args) {
    if (helper.isString(polling))
      assert(polling === 'raf' || polling === 'mutation', 'Unknown polling option: ' + polling);
    else if (helper.isNumber(polling))
      assert(polling > 0, 'Cannot poll with non-positive interval: ' + polling);
    else
      throw new Error('Unknown polling options: ' + polling);

    this._frame = frame;
    this._polling = polling;
    this._timeout = timeout;
    this._predicateBody = helper.isString(predicateBody) ? 'return ' + predicateBody : 'return (' + predicateBody + ')(...args)';
    this._args = args;
    this._runCount = 0;
    frame._waitTasks.add(this);
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    // Since page navigation requires us to re-install the pageScript, we should track
    // timeout on our end.
    if (timeout) {
      const timeoutError = new TimeoutError(`waiting for ${title} failed: timeout ${timeout}ms exceeded`);
      this._timeoutTimer = setTimeout(() => this.terminate(timeoutError), timeout);
    }
    this.rerun();
  }

  /**
   * @param {!Error} error
   */
  terminate(error) {
    this._terminated = true;
    this._reject(error);
    this._cleanup();
  }

  async rerun() {
    const runCount = ++this._runCount;
    /** @type {?JSHandle} */
    let success = null;
    let error = null;
    try {
      success = await this._frame.evaluateHandle(waitForPredicatePageFunction, this._predicateBody, this._polling, this._timeout, ...this._args);
    } catch (e) {
      error = e;
    }

    if (this._terminated || runCount !== this._runCount) {
      if (success)
        await success.dispose();
      return;
    }

    // Ignore timeouts in pageScript - we track timeouts ourselves.
    // If the frame's execution context has already changed, `frame.evaluate` will
    // throw an error - ignore this predicate run altogether.
    if (!error && await this._frame.evaluate(s => !s, success).catch(e => true)) {
      await success.dispose();
      return;
    }

    // When the page is navigated, the promise is rejected.
    // Try again right away.
    if (error && error.message.includes('Execution context was destroyed')) {
      this.rerun();
      return;
    }

    if (error)
      this._reject(error);
    else
      this._resolve(success);

    this._cleanup();
  }

  _cleanup() {
    clearTimeout(this._timeoutTimer);
    this._frame._waitTasks.delete(this);
    this._runningTask = null;
  }
}

/**
 * @param {string} predicateBody
 * @param {string} polling
 * @param {number} timeout
 * @return {!Promise<*>}
 */
async function waitForPredicatePageFunction(predicateBody, polling, timeout, ...args) {
  const predicate = new Function('...args', predicateBody);
  let timedOut = false;
  if (timeout)
    setTimeout(() => timedOut = true, timeout);
  if (polling === 'raf')
    return await pollRaf();
  if (polling === 'mutation')
    return await pollMutation();
  if (typeof polling === 'number')
    return await pollInterval(polling);

  /**
   * @return {!Promise<*>}
   */
  function pollMutation() {
    const success = predicate.apply(null, args);
    if (success)
      return Promise.resolve(success);

    let fulfill;
    const result = new Promise(x => fulfill = x);
    const observer = new MutationObserver(mutations => {
      if (timedOut) {
        observer.disconnect();
        fulfill();
      }
      const success = predicate.apply(null, args);
      if (success) {
        observer.disconnect();
        fulfill(success);
      }
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true
    });
    return result;
  }

  /**
   * @return {!Promise<*>}
   */
  function pollRaf() {
    let fulfill;
    const result = new Promise(x => fulfill = x);
    onRaf();
    return result;

    function onRaf() {
      if (timedOut) {
        fulfill();
        return;
      }
      const success = predicate.apply(null, args);
      if (success)
        fulfill(success);
      else
        requestAnimationFrame(onRaf);
    }
  }

  /**
   * @param {number} pollInterval
   * @return {!Promise<*>}
   */
  function pollInterval(pollInterval) {
    let fulfill;
    const result = new Promise(x => fulfill = x);
    onTimeout();
    return result;

    function onTimeout() {
      if (timedOut) {
        fulfill();
        return;
      }
      const success = predicate.apply(null, args);
      if (success)
        fulfill(success);
      else
        setTimeout(onTimeout, pollInterval);
    }
  }
}

function normalizeWaitUntil(waitUntil) {
  if (!Array.isArray(waitUntil))
    waitUntil = [waitUntil];
  for (const condition of waitUntil) {
    if (condition !== 'load' && condition !== 'domcontentloaded')
      throw new Error('Unknown waitUntil condition: ' + condition);
  }
  return waitUntil;
}

module.exports = {FrameManager, Frame, normalizeWaitUntil};
