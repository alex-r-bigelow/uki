const createMixinAndDefault = function ({
  DefaultSuperClass = Object,
  classDefFunc,
  requireDefault = true,
  allowRemixinHandler = () => false,
  mixedInstanceOfDefault = true
}) {
  // Mixin function
  const Mixin = function (SuperClass) {
    if (SuperClass instanceof Mixin && !allowRemixinHandler(SuperClass)) {
      // If the same mixin is used more than once, generally we don't want to
      // remix; allowRemixinHandler can return true if we really allow for this,
      // and/or do special things in the event of a remix
      return SuperClass;
    }
    // Mixed class definition can inherit any arbitrary SuperClass...
    const MixedClass = classDefFunc(SuperClass);
    if (requireDefault &&
        SuperClass !== DefaultSuperClass &&
        !(MixedClass.prototype instanceof DefaultSuperClass)) {
      // ... but in most cases, we require that it EVENTUALLY inherits from
      // DefaultSuperClass. Can be overridden with requireDefault = false
      throw new Error(`${MixedClass.name} must inherit from ${DefaultSuperClass.name}`);
    }
    // Add a hidden property to the mixed class so we can handle instanceof
    // checks properly
    MixedClass.prototype[`_instanceOf${MixedClass.name}`] = true;
    return MixedClass;
  };
  // Default class definition inherits directly from DefaultSuperClass
  const DefaultClass = Mixin(DefaultSuperClass);
  // Make the Mixin function behave like a class for instanceof Mixin checks
  Object.defineProperty(Mixin, Symbol.hasInstance, {
    value: i => !!i?.[`_instanceOf${DefaultClass.name}`]
  });
  if (mixedInstanceOfDefault) {
    // Make instanceof DefaultClass true for anything that technically is only
    // an instanceof Mixin
    Object.defineProperty(DefaultClass, Symbol.hasInstance, {
      value: i => !!i?.[`_instanceOf${DefaultClass.name}`]
    });
  }
  // Return both the default class and the mixin function
  const wrapper = {};
  wrapper[DefaultClass.name] = DefaultClass;
  wrapper[DefaultClass.name + 'Mixin'] = Mixin;
  return wrapper;
};

const { Introspectable, IntrospectableMixin } = createMixinAndDefault({
  DefaultSuperClass: Object,
  requireDefault: false,
  classDefFunc: SuperClass => {
    class Introspectable extends SuperClass {
      get type () {
        return this.constructor.type;
      }

      get lowerCamelCaseType () {
        return this.constructor.lowerCamelCaseType;
      }

      get humanReadableType () {
        return this.constructor.humanReadableType;
      }
    }
    Object.defineProperty(Introspectable, 'type', {
      // This can / should be overridden by subclasses that follow a common string
      // pattern, such as RootToken, KeysToken, ParentToken, etc.
      configurable: true,
      get () { return this.name; }
    });
    Object.defineProperty(Introspectable, 'lowerCamelCaseType', {
      get () {
        const temp = this.type;
        return temp.replace(/./, temp[0].toLocaleLowerCase());
      }
    });
    Object.defineProperty(Introspectable, 'humanReadableType', {
      get () {
        // CamelCase to Sentence Case
        return this.type.replace(/([a-z])([A-Z])/g, '$1 $2');
      }
    });
    return Introspectable;
  }
});

var utils = /*#__PURE__*/Object.freeze({
  __proto__: null,
  createMixinAndDefault: createMixinAndDefault,
  Introspectable: Introspectable,
  IntrospectableMixin: IntrospectableMixin
});

/* globals d3, less */

const { Model, ModelMixin } = createMixinAndDefault({
  DefaultSuperClass: Object,
  classDefFunc: SuperClass => {
    class Model extends SuperClass {
      constructor (options = {}) {
        super(...arguments);
        this._eventHandlers = {};
        this._pendingEvents = {};
        this._stickyTriggers = {};
        this._resourceSpecs = options.resources || [];
        this._resourceLookup = {};
        this._resourcesLoaded = false;
        this.ready = this._loadResources(this._resourceSpecs)
          .then(() => {
            this._resourcesLoaded = true;
            this.trigger('load');
          });
      }

      _loadJS (url, raw, extraAttrs = {}) {
        if (Model.JS_PROMISES[url || raw]) {
          // We've already loaded the script
          return Model.JS_PROMISES[url || raw];
          // TODO: probably not worth the extra check for
          // document.querySelector(`script[src="${url}"]`)
          // because we have no way of knowing if its onload() has already been
          // been fired. Better to rely on clients to check on their own if a
          // library already exists (i.e. was loaded outside uki) before trying to
          // have uki load it
        }
        const script = document.createElement('script');
        script.type = 'application/javascript';
        for (const [key, value] of Object.entries(extraAttrs)) {
          script.setAttribute(key, value);
        }
        if (url !== undefined) {
          script.src = url;
        } else if (raw !== undefined) {
          script.innerText = raw;
        } else {
          throw new Error('Either a url or raw argument is required for JS resources');
        }
        Model.JS_PROMISES[url || raw] = new Promise((resolve, reject) => {
          script.addEventListener('load', () => { resolve(script); });
        });
        document.getElementsByTagName('head')[0].appendChild(script);
        return Model.JS_PROMISES[url];
      }

      _loadCSS (url, raw, extraAttrs = {}, unshift = false, prelimResults = {}) {
        if (url !== undefined) {
          let linkTag = document.querySelector(`link[href="${url}"]`);
          if (linkTag) {
            // We've already added this stylesheet
            Object.assign(prelimResults, { linkTag, cssVariables: this.extractCSSVariables(linkTag) });
            return Promise.resolve(prelimResults);
          }
          linkTag = document.createElement('link');
          linkTag.rel = 'stylesheet';
          linkTag.type = 'text/css';
          linkTag.media = 'screen';
          for (const [key, value] of Object.keys(extraAttrs)) {
            linkTag.setAttribute(key, value);
          }
          const loadPromise = new Promise((resolve, reject) => {
            linkTag.onload = () => {
              Object.assign(prelimResults, { linkTag, cssVariables: this.extractCSSVariables(linkTag) });
              resolve(prelimResults);
            };
          });
          linkTag.href = url;
          document.getElementsByTagName('head')[0].appendChild(linkTag);
          return loadPromise;
        } else if (raw !== undefined) {
          if (Model.RAW_CSS_PROMISES[raw]) {
            return Model.RAW_CSS_PROMISES[raw];
          }
          const styleTag = document.createElement('style');
          styleTag.type = 'text/css';
          for (const [key, value] of Object.keys(extraAttrs)) {
            styleTag.setAttribute(key, value);
          }
          if (styleTag.styleSheet) {
            styleTag.styleSheet.cssText = raw;
          } else {
            styleTag.innerHTML = raw;
          }
          const head = document.getElementsByTagName('head')[0];
          if (unshift) {
            head.prepend(styleTag);
          } else {
            head.appendChild(styleTag);
          }
          Object.assign(prelimResults, { styleTag, cssVariables: this.extractCSSVariables(styleTag) });
          Model.RAW_CSS_PROMISES[raw] = prelimResults;
          return Model.RAW_CSS_PROMISES[raw];
        } else {
          throw new Error('Either a url or raw argument is required for CSS resources');
        }
      }

      extractCSSVariables (tag) {
        const result = {};

        const computedStyles = globalThis.getComputedStyle(document.documentElement);

        const extractRules = parent => {
          for (const rule of parent.cssRules) {
            if (rule.selectorText === ':root') {
              for (const variableName of rule.style) {
                result[variableName] = computedStyles.getPropertyValue(variableName).trim();
              }
            } else if (rule.cssRules) {
              extractRules(rule);
            }
          }
        };

        extractRules(tag.sheet);
        return result;
      }

      async _loadLESS (url, raw, extraAttrs = {}, lessArgs = {}, unshift = false) {
        if (url !== undefined) {
          if (Model.LESS_PROMISES[url]) {
            return Model.LESS_PROMISES[url];
          } else if (document.querySelector(`link[href="${url}"]`)) {
            return Promise.resolve(document.querySelector(`link[href="${url}"]`));
          }
        } else if (raw !== undefined) {
          if (Model.LESS_PROMISES[raw]) {
            return Model.LESS_PROMISES[raw];
          }
        } else {
          throw new Error('Either a url or raw argument is required for LESS resources');
        }
        const cssPromise = url ? less.render(`@import '${url}';`) : less.render(raw, lessArgs);
        Model.LESS_PROMISES[url || raw] = cssPromise.then(result => {
          // TODO: there isn't a way to get variable declarations out of
          // less.render... but ideally we'd want to add a
          // prelimResults = { lessVariables: {} }
          // argument here
          return this._loadCSS(undefined, result.css, extraAttrs, unshift);
        });
        return Model.LESS_PROMISES[url || raw];
      }

      async _getCoreResourcePromise (spec) {
        let p;
        if (spec instanceof Promise) {
          // An arbitrary promise
          return spec;
        } else if (spec.type === 'css') {
          // Load pure css directly
          p = this._loadCSS(spec.url, spec.raw, spec.extraAttributes || {}, spec.unshift);
        } else if (spec.type === 'less') {
          // Convert LESS to CSS
          p = this._loadLESS(spec.url, spec.raw, spec.extraAttributes || {}, spec.lessArgs || {}, spec.unshift);
        } else if (spec.type === 'fetch') {
          // Raw fetch request
          p = globalThis.fetch(spec.url, spec.init || {});
        } else if (spec.type === 'js') {
          // Load a legacy JS script (i.e. something that can't be ES6-imported)
          p = this._loadJS(spec.url, spec.raw, spec.extraAttributes || {});
        } else if (d3[spec.type]) {
          // One of D3's native types
          const args = [];
          if (spec.init) {
            args.push(spec.init);
          }
          if (spec.row) {
            args.push(spec.row);
          }
          if (spec.type === 'dsv') {
            p = d3[spec.type](spec.delimiter, spec.url, ...args);
          } else {
            p = d3[spec.type](spec.url, ...args);
          }
        } else {
          throw new Error(`Can't load resource ${spec.url} of type ${spec.type}`);
        }
        if (spec.then) {
          if (spec.storeOriginalResult) {
            p.then(spec.then);
          } else {
            p = p.then(spec.then);
          }
        }
        return p;
      }

      async ensureLessIsLoaded () {
        if (!globalThis.less || !globalThis.less.render) {
          if (!globalThis.less) {
            // Initial settings
            globalThis.less = { logLevel: 0 };
            globalThis._ukiLessPromise = this._loadJS(globalThis.uki.dynamicDependencies.less);
          }
          await globalThis._ukiLessPromise;
        }
      }

      async loadLateResource (spec, override = false) {
        await this.ready;
        this._resourcesLoaded = false;
        if (this._resourceLookup[spec.name] !== undefined) {
          if (override) {
            return this.updateResource(spec);
          } else {
            throw new Error(`Resource ${spec.name} already exists, use override = true to overwrite`);
          }
        }
        if (spec.type === 'less') {
          await this.ensureLessIsLoaded();
        }
        if (spec.name) {
          this._resourceLookup[spec.name] = this.resources.length;
        }
        this.resources.push(await this._getCoreResourcePromise(spec));
        this._resourcesLoaded = true;
        this.trigger('load');
      }

      async updateResource (spec, allowLate = false) {
        await this.ready;
        this._resourcesLoaded = false;
        const index = this._resourceLookup[spec.name];
        if (index === undefined) {
          if (allowLate) {
            return this.loadLateResource(spec);
          } else {
            throw new Error(`Can't update unknown resource: ${spec.name}, use allowLate = true to create anyway`);
          }
        }
        if (spec.type === 'less') {
          await this.ensureLessIsLoaded();
        }
        this.resources[index] = await this._getCoreResourcePromise(spec);
        this._resourcesLoaded = true;
        this.trigger('load');
      }

      async _loadResources (specs = []) {
        // uki itself needs d3.js; make sure it exists
        if (!globalThis.d3) {
          await this._loadJS(globalThis.uki.dynamicDependencies.d3);
        }

        // Don't need to do anything else; this makes some code cleaner below
        if (specs.length === 0) {
          return;
        }

        // First, construct a lookup of named dependencies
        specs.forEach((spec, i) => {
          if (spec.name) {
            this._resourceLookup[spec.name] = i;
          }
        });
        // Next, collect dependencies, with a deep copy for Kahn's algorithm to delete
        let hasLESSresources = false;
        const tempDependencies = [];
        const dependencies = specs.map((spec, i) => {
          const result = [];
          if (spec.type === 'less') {
            hasLESSresources = true;
          }
          for (const name of spec.loadAfter || []) {
            if (this._resourceLookup[name] === undefined) {
              throw new Error(`Can't loadAfter unknown resource: ${name}`);
            }
            result.push(this._resourceLookup[name]);
          }
          tempDependencies.push(Array.from(result));
          return result;
        });
        // Add and await LESS script if needed
        if (hasLESSresources) {
          await this.ensureLessIsLoaded();
        }
        // Now do Kahn's algorithm to topologically sort the graph, starting from
        // the resources with no dependencies
        const roots = Object.keys(specs)
          .filter(index => dependencies[index].length === 0);
        // Ensure that there's at least one root with no dependencies
        if (roots.length === 0) {
          throw new Error('No resource without loadAfter dependencies');
        }
        const topoSortOrder = [];
        while (roots.length > 0) {
          const index = parseInt(roots.shift());
          topoSortOrder.push(index);
          // Remove references to index from the graph
          for (const [childIndex, refList] of Object.entries(tempDependencies)) {
            const refIndex = refList.indexOf(index);
            if (refIndex > -1) {
              refList.splice(refIndex, 1);
              // If we removed this child's last dependency, it can go into the roots
              if (refList.length === 0) {
                roots.push(childIndex);
              }
            }
          }
        }
        if (topoSortOrder.length !== specs.length) {
          throw new Error('Cyclic loadAfter resource dependency');
        }
        // Load dependencies in topological order
        const resourcePromises = [];
        for (const index of topoSortOrder) {
          const parentPromises = dependencies[index]
            .map(parentIndex => resourcePromises[parentIndex]);
          resourcePromises[index] = Promise.all(parentPromises)
            .then(() => this._getCoreResourcePromise(specs[index]));
        }

        this.resources = await Promise.all(resourcePromises);
      }

      getNamedResource (name) {
        return this._resourceLookup[name] === undefined ? null
          : this.resources[this._resourceLookup[name]];
      }

      on (eventName, callback) {
        const [event, namespace] = eventName.split('.');
        this._eventHandlers[event] = this._eventHandlers[event] || { '': [] };
        this._pendingEvents[event] = this._pendingEvents[event] || [];
        if (!namespace) {
          this._eventHandlers[event][''].push(callback);
        } else {
          this._eventHandlers[event][namespace] = callback;
        }
      }

      off (eventName, callback) {
        const [event, namespace] = eventName.split('.');
        if (this._eventHandlers[event]) {
          if (!namespace) {
            if (!callback) {
              // No namespace or specific callback function; remove all handlers
              // and pending events for this event
              this._eventHandlers[event][''] = [];
              delete this._pendingEvents[event];
            } else {
              // Only remove handlers and pending events for a specific callback
              // function
              const index = this._eventHandlers[event][''].indexOf(callback);
              if (index >= 0) {
                this._eventHandlers[event][''].splice(index, 1);
              }
              for (const [index, eventParams] of Object.entries(this._pendingEvents[event])) {
                if (eventParams.callback === callback) {
                  delete this._pendingEvents[event][index];
                }
              }
            }
          } else {
            // Remove all handlers and pending events that use this namespace
            // (when dealing with namespaces, the specific callback function
            // is irrelevant)
            delete this._eventHandlers[event][namespace];
            for (const [index, eventParams] of Object.entries(this._pendingEvents[event])) {
              if (eventParams.namespace === namespace) {
                delete this._pendingEvents[event][index];
              }
            }
          }
        }
      }

      async trigger (event, ...args) {
        const handleCallback = (callback, namespace = '') => {
          const index = this._pendingEvents[event].length;
          this._pendingEvents[event].push({ thisObj: this, callback, args, namespace });
          // Make a local pointer, because this could get swapped out by takeOverEvents()
          const pendingEventList = this._pendingEvents[event];
          return new Promise((resolve, reject) => {
            globalThis.setTimeout(() => { // Timeout to prevent blocking
              if (!pendingEventList[index]) {
                reject(new Error(`Listener for event ${event} was removed before pending callback could be executed`));
              } else {
                const eventParams = pendingEventList[index];
                delete pendingEventList[index];
                resolve(callback.apply(eventParams.thisObj, eventParams.callback, eventParams.args));
              }
            }, 0);
          });
        };
        const promises = [];
        if (this._eventHandlers[event]) {
          for (const namespace of Object.keys(this._eventHandlers[event])) {
            if (namespace === '') {
              promises.push(...this._eventHandlers[event][''].map(handleCallback));
            } else {
              promises.push(handleCallback(this._eventHandlers[event][namespace], namespace));
            }
          }
        }
        return Promise.all(promises);
      }

      async stickyTrigger (eventName, argObj, delay = 10) {
        this._stickyTriggers[eventName] = this._stickyTriggers[eventName] || { thisObj: this, argObj: {}, timeout: undefined };
        Object.assign(this._stickyTriggers[eventName].argObj, argObj);
        clearTimeout(this._stickyTriggers[eventName].timeout);
        // Make a local pointer, because this could get swapped out by takeOverEvents()
        const stickyTriggers = this._stickyTriggers;
        return new Promise((resolve, reject) => {
          stickyTriggers[eventName].timeout = setTimeout(() => {
            const stickyParams = stickyTriggers[eventName];
            delete stickyTriggers[eventName];
            try {
              resolve(stickyParams.thisObj.trigger(eventName, stickyParams.argObj));
            } catch (error) {
              reject(error);
            }
          }, delay);
        });
      }

      takeOverEvents (otherModel) {
        Object.assign(this._eventHandlers, otherModel._eventHandlers);
        otherModel._eventHandlers = {};

        // For any pending events + sticky events, we ONLY need to take over the
        // thisObj; things will still be appropriately deleted via local pointers

        for (const stickyParams of Object.values(otherModel._stickyTriggers)) {
          stickyParams.thisObj = this;
        }
        otherModel._stickyTriggers = {};

        for (const paramList of Object.values(otherModel._pendingEvents)) {
          for (const eventParams of paramList) {
            eventParams.thisObj = this;
          }
        }
        otherModel._pendingEvents = {};
      }
    }
    Model.LESS_PROMISES = {};
    Model.JS_PROMISES = {};
    Model.RAW_CSS_PROMISES = {};
    return Model;
  }
});

/* globals d3, HTMLElement */

const { View, ViewMixin } = createMixinAndDefault({
  DefaultSuperClass: Model,
  classDefFunc: SuperClass => {
    class View extends SuperClass {
      constructor (options = {}) {
        super(options);
        this.dirty = true;
        this.debounceWait = options.debounceWait || 100;
        this._mutationObserver = null;
        this._drawTimeout = null;
        this._renderResolves = [];
        this.resetPauseReasons();
        this.claimD3elOwnership(options.d3el || null, true);
        if (!options.suppressInitialRender) {
          this.render();
        }
      }

      claimD3elOwnership (d3el, skipRenderCall = false) {
        if (d3el instanceof HTMLElement) {
          d3el = d3.select(HTMLElement);
        }
        if (d3el) {
          if (d3el.size() === 0) {
            console.warn('Ignoring empty d3 selection assigned to uki.js View');
            return;
          } else if (d3el.size() > 1) {
            console.warn('Ignoring d3 selection with multiple nodes assigned to uki.js View');
            return;
          }

          const newNode = d3el.node();

          let claimNode = false;
          let revokeOldOwnership = false;
          if (!this.d3el) {
            // Always claim if we don't currently have an element
            claimNode = true;
            revokeOldOwnership = !!newNode.__ukiView__;
          } else {
            // Only go through the process of claiming the new node if it's
            // different from our current one
            claimNode = newNode !== this.d3el.node();
            revokeOldOwnership = claimNode && newNode.__ukiView__;
          }

          if (revokeOldOwnership) {
            // The new element already had a view; let it know that we've taken over
            newNode.__ukiView__.revokeD3elOwnership();
          }

          if (claimNode) {
            if (this.d3el) {
              // We've been given a different element than what we used before
              const oldNode = this.d3el.node();
              delete oldNode.__ukiView__;
              if (this._mutationObserver) {
                this._mutationObserver.disconnect();
              }
            }

            // Assign ourselves the new new node
            newNode.__ukiView__ = this;
            this.d3el = d3el;
            this.dirty = true;
            delete this._pauseRenderReasons['No d3el'];

            // Detect if the DOM node is ever removed
            this._mutationObserver = new globalThis.MutationObserver(mutationList => {
              for (const mutation of mutationList) {
                for (const removedNode of mutation.removedNodes) {
                  if (removedNode === newNode) {
                    this.revokeD3elOwnership();
                  }
                }
              }
            });
            this._mutationObserver.observe(newNode.parentNode, { childList: true });

            if (!skipRenderCall) {
              this.render();
            }
          }
        }
      }

      revokeD3elOwnership () {
        if (this.d3el) {
          delete this.d3el.node().__ukiView__;
        }
        if (this._mutationObserver) {
          this._mutationObserver.disconnect();
        }
        this.d3el = null;
        this.pauseRender('No d3el');
      }

      pauseRender (reason) {
        this._pauseRenderReasons[reason] = true;
        this.trigger('pauseRender', reason);
      }

      resumeRender (reason) {
        if (!reason) {
          this.resetPauseReasons();
        } else {
          delete this._pauseRenderReasons[reason];
        }
        if (!this.renderPaused) {
          this.trigger('resumeRender');
          this.render();
        }
      }

      resetPauseReasons () {
        this._pauseRenderReasons = {};
        if (!this.d3el) {
          this._pauseRenderReasons['No d3el'] = true;
        }
      }

      get renderPaused () {
        return Object.keys(this._pauseRenderReasons).length > 0;
      }

      async render (d3el = this.d3el) {
        this.claimD3elOwnership(d3el, true);

        await this.ready;
        if (this.renderPaused) {
          // Don't execute any render calls until all resources are loaded,
          // we've actually been given a d3 element to work with, and we're not
          // paused for another reason
          return new Promise((resolve, reject) => {
            this._renderResolves.push(resolve);
          });
        }

        if (this.dirty && this._setupPromise === undefined) {
          // Need a fresh render; call setup immediately
          this.updateContainerCharacteristics(this.d3el);
          this._setupPromise = this.setup(this.d3el);
          this.dirty = false;
          try {
            await this._setupPromise;
          } catch (err) {
            if (this.setupError) {
              this._setupPromise = this.setupError(this.d3el, err);
              await this._setupPromise;
            } else {
              throw err;
            }
          }
          delete this._setupPromise;
          this.trigger('setupFinished');
        }

        // Debounce the actual draw call, and return a promise that will resolve
        // when draw() actually finishes
        return new Promise((resolve, reject) => {
          this._renderResolves.push(resolve);
          clearTimeout(this._drawTimeout);
          this._drawTimeout = setTimeout(async () => {
            this._drawTimeout = null;
            if (this._setupPromise) {
              // Don't try / catch here because if there's an error, it will
              // be handled exactly once in the original context
              await this._setupPromise;
            }
            if (this.renderPaused) {
              // Check if we've been paused after setup(), but before draw(); if
              // we've been paused, wait for another render() call to resolve
              // everything in this._renderResolves
              return;
            }
            let result;
            try {
              result = await this.draw(this.d3el);
            } catch (err) {
              if (this.drawError) {
                result = await this.drawError(this.d3el, err);
              } else {
                throw err;
              }
            }
            this.trigger('drawFinished');
            const temp = this._renderResolves;
            this._renderResolves = [];
            for (const r of temp) {
              r(result);
            }
          }, this.debounceWait);
        });
      }

      async setup (d3el = this.d3el) {}

      async draw (d3el = this.d3el) {}

      updateContainerCharacteristics (d3el) {
        this.emSize = parseFloat(d3el.style('font-size'));
        this.scrollBarSize = this.computeScrollBarSize(d3el);
      }

      getBounds (d3el = this.d3el) {
        if (d3el) {
          return d3el.node().getBoundingClientRect();
        } else {
          return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
        }
      }

      computeScrollBarSize (d3el) {
        // blatantly adapted from SO thread:
        // http://stackoverflow.com/questions/13382516/getting-scroll-bar-width-using-javascript
        var outer = document.createElement('div');
        outer.style.visibility = 'hidden';
        outer.style.width = '100px';
        outer.style.msOverflowStyle = 'scrollbar'; // needed for WinJS apps

        d3el.node().appendChild(outer);

        var widthNoScroll = outer.offsetWidth;
        // force scrollbars
        outer.style.overflow = 'scroll';

        // add innerdiv
        var inner = document.createElement('div');
        inner.style.width = '100%';
        outer.appendChild(inner);

        var widthWithScroll = inner.offsetWidth;

        // remove divs
        outer.parentNode.removeChild(outer);

        return widthNoScroll - widthWithScroll;
      }

      static async initForD3Selection (selection, optionsAccessor = d => d) {
        const ClassDef = this;
        const promises = [];
        selection.each(function () {
          const view = new ClassDef(optionsAccessor(...arguments));
          promises.push(view.render(d3.select(this)));
        });
        return Promise.all(promises);
      }

      static async iterD3Selection (selection, func) {
        const promises = [];
        selection.each(function () {
          promises.push(func.call(this, this.__ukiView__, ...arguments));
        });
        return Promise.all(promises);
      }
    }
    return View;
  }
});

var name = "uki";
var version = "0.7.6";
var description = "Minimal, d3-based Model-View library";
var module = "dist/uki.esm.js";
var scripts = {
	example: "bash examples/run.sh",
	build: "rollup -c",
	lint: "eslint **/*.js --quiet",
	dev: "rollup -c -w"
};
var repository = {
	type: "git",
	url: "git+https://github.com/ukijs/uki.git"
};
var author = "Alex Bigelow";
var license = "MIT";
var bugs = {
	url: "https://github.com/ukijs/uki/issues"
};
var homepage = "https://github.com/ukijs/uki#readme";
var eslintConfig = {
	"extends": "standard",
	rules: {
		semi: [
			2,
			"always"
		],
		"no-extra-semi": 2,
		"semi-spacing": [
			2,
			{
				before: false,
				after: true
			}
		]
	},
	globals: {
		globalThis: false
	}
};
var devDependencies = {
	"@rollup/plugin-json": "^4.1.0",
	eslint: "^7.13.0",
	"eslint-config-semistandard": "^15.0.1",
	"eslint-config-standard": "^16.0.1",
	"eslint-plugin-import": "^2.22.1",
	"eslint-plugin-node": "^11.1.0",
	"eslint-plugin-promise": "^4.2.1",
	"eslint-plugin-standard": "^4.1.0",
	rollup: "^2.33.1",
	"rollup-plugin-execute": "^1.1.1",
	serve: "^11.3.2"
};
var peerDependencies = {
	d3: "^6.2.0"
};
var optionalDependencies = {
	less: "^3.12.2"
};
var pkg = {
	name: name,
	version: version,
	description: description,
	module: module,
	"jsnext:main": "dist/uki.esm.js",
	scripts: scripts,
	repository: repository,
	author: author,
	license: license,
	bugs: bugs,
	homepage: homepage,
	eslintConfig: eslintConfig,
	devDependencies: devDependencies,
	peerDependencies: peerDependencies,
	optionalDependencies: optionalDependencies
};

const version$1 = pkg.version;

globalThis.uki = globalThis.uki || {};
globalThis.uki.Model = Model;
globalThis.uki.ModelMixin = ModelMixin;
globalThis.uki.View = View;
globalThis.uki.ViewMixin = ViewMixin;
globalThis.uki.utils = utils;
globalThis.uki.version = version$1;

const d3Version = pkg.peerDependencies.d3.match(/[\d.]+/)[0];
const lessVersion = pkg.optionalDependencies.less.match(/[\d.]+/)[0];

globalThis.uki.dynamicDependencies = {
  d3: `https://cdnjs.cloudflare.com/ajax/libs/d3/${d3Version}/d3.min.js`,
  less: `https://cdnjs.cloudflare.com/ajax/libs/less.js/${lessVersion}/less.min.js`
};

export { Model, View, utils, version$1 as version };