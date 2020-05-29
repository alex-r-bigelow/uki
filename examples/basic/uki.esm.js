/* globals d3, less */

class Model {
  constructor (options = {}) {
    this._eventHandlers = {};
    this._stickyTriggers = {};
    this._resourceSpecs = options.resources || [];
    this.ready = new Promise(async (resolve, reject) => {
      await this._loadResources(this._resourceSpecs);
      this.trigger('load');
      resolve();
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
  _loadCSS (url, raw, extraAttrs = {}) {
    if (url !== undefined) {
      if (document.querySelector(`link[href="${url}"]`)) {
        // We've already added this stylesheet
        return Promise.resolve(document.querySelector(`link[href="${url}"]`));
      }
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.type = 'text/css';
      link.media = 'screen';
      for (const [key, value] of Object.keys(extraAttrs)) {
        link.setAttribute(key, value);
      }
      const loadPromise = new Promise((resolve, reject) => {
        link.onload = () => { resolve(link); };
      });
      link.href = url;
      document.getElementsByTagName('head')[0].appendChild(link);
      return loadPromise;
    } else if (raw !== undefined) {
      if (Model.RAW_CSS[raw]) {
        return;
      }
      const style = document.createElement('style');
      style.type = 'text/css';
      for (const [key, value] of Object.keys(extraAttrs)) {
        style.setAttribute(key, value);
      }
      if (style.styleSheet) {
        style.styleSheet.cssText = raw;
      } else {
        style.innerHTML = raw;
      }
      Model.RAW_CSS[raw] = true;
      document.getElementsByTagName('head')[0].appendChild(style);
      return Promise.resolve(style);
    } else {
      throw new Error('Either a url or raw argument is required for CSS resources');
    }
  }
  async _loadLESS (url, raw, extraAttrs = {}, lessArgs = {}) {
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
      // TODO: maybe do magic here to make LESS variables accessible under
      // this.resources?
      return this._loadCSS(undefined, result.css, extraAttrs);
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
      p = this._loadCSS(spec.url, spec.raw, spec.extraAttributes || {});
    } else if (spec.type === 'less') {
      // Convert LESS to CSS
      p = this._loadLESS(spec.url, spec.raw, spec.extraAttributes || {}, spec.lessArgs || {});
    } else if (spec.type === 'fetch') {
      // Raw fetch request
      p = window.fetch(spec.url, spec.init || {});
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
    if (!window.less || !window.less.render) {
      if (!window.less) {
        // Initial settings
        window.less = { logLevel: 0 };
        window._ukiLessPromise = this._loadJS('https://cdnjs.cloudflare.com/ajax/libs/less.js/3.11.1/less.min.js');
      }
      await window._ukiLessPromise;
    }
  }
  async _loadResources (specs = []) {
    // uki itself needs d3.js; make sure it exists
    if (!window.d3) {
      await this._loadJS('https://d3js.org/d3.v5.min.js');
    }

    // Don't need to do anything else; this makes some code cleaner below
    if (specs.length === 0) {
      return;
    }

    // First, construct a lookup of named dependencies
    this._resourceLookup = {};
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
    let roots = Object.keys(specs)
      .filter(index => dependencies[index].length === 0);
    // Ensure that there's at least one root with no dependencies
    if (roots.length === 0) {
      throw new Error(`No resource without loadAfter dependencies`);
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
      throw new Error(`Cyclic loadAfter resource dependency`);
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
    let [event, namespace] = eventName.split('.');
    this._eventHandlers[event] = this._eventHandlers[event] ||
      { '': [] };
    if (!namespace) {
      this._eventHandlers[event][''].push(callback);
    } else {
      this._eventHandlers[event][namespace] = callback;
    }
  }
  off (eventName, callback) {
    let [event, namespace] = eventName.split('.');
    if (this._eventHandlers[event]) {
      if (!namespace) {
        if (!callback) {
          this._eventHandlers[event][''] = [];
        } else {
          let index = this._eventHandlers[event][''].indexOf(callback);
          if (index >= 0) {
            this._eventHandlers[event][''].splice(index, 1);
          }
        }
      } else {
        delete this._eventHandlers[event][namespace];
      }
    }
  }
  trigger (event, ...args) {
    // TODO: maybe promise-ify this, so that anyone triggering an event has a
    // way of knowing that everyone has finished responding to it?
    const handleCallback = callback => {
      window.setTimeout(() => { // Timeout to prevent blocking
        callback.apply(this, args);
      }, 0);
    };
    if (this._eventHandlers[event]) {
      for (const namespace of Object.keys(this._eventHandlers[event])) {
        if (namespace === '') {
          this._eventHandlers[event][''].forEach(handleCallback);
        } else {
          handleCallback(this._eventHandlers[event][namespace]);
        }
      }
    }
  }
  stickyTrigger (eventName, argObj, delay = 10) {
    this._stickyTriggers[eventName] = this._stickyTriggers[eventName] || { argObj: {} };
    Object.assign(this._stickyTriggers[eventName].argObj, argObj);
    clearTimeout(this._stickyTriggers.timeout);
    this._stickyTriggers.timeout = setTimeout(() => {
      let argObj = this._stickyTriggers[eventName].argObj;
      delete this._stickyTriggers[eventName];
      this.trigger(eventName, argObj);
    }, delay);
  }
}
Model.LESS_PROMISES = {};
Model.JS_PROMISES = {};
Model.RAW_CSS = {};

/**
 * View classes
 */
class View extends Model {
  constructor (options = {}) {
    super(options);
    this.d3el = this.checkForEmptySelection(options.d3el || null);
    this.dirty = true;
    this._drawTimeout = null;
    this._renderResolves = [];
    this.debounceWait = options.debounceWait || 100;
    if (!options.suppressInitialRender) {
      this.render();
    }
  }
  checkForEmptySelection (d3el) {
    if (d3el && d3el.node() === null) {
      // Only trigger a warning if an empty selection gets passed in; undefined
      // is still just fine because render() doesn't always require an argument
      console.warn('Empty d3 selection passed to uki.js View');
      return null;
    } else {
      return d3el;
    }
  }
  async render (d3el = this.d3el) {
    d3el = this.checkForEmptySelection(d3el);
    if (!this.d3el || (d3el && d3el.node() !== this.d3el.node())) {
      this.d3el = d3el;
      this.dirty = true;
    }
    if (!this.d3el) {
      // Don't execute any render calls until all resources are loaded,
      // and we've actually been given a d3 element to work with
      return new Promise((resolve, reject) => {
        this._renderResolves.push(resolve);
      });
    }
    await this.ready;
    if (this.dirty && this._setupPromise === undefined) {
      // Need a fresh render; call setup immediately
      this.d3el = d3el;
      this.updateContainerCharacteristics(this.d3el);
      this._setupPromise = this.setup(this.d3el);
      this.dirty = false;
      await this._setupPromise;
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
          await this._setupPromise;
        }
        const result = await this.draw(this.d3el);
        this.trigger('drawFinished');
        const temp = this._renderResolves;
        this._renderResolves = [];
        for (const r of temp) {
          r(result);
        }
      }, this.debounceWait);
    });
  }

  setup (d3el = this.d3el) {}
  draw (d3el = this.d3el) {}
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
}

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
        !(SuperClass.prototype instanceof DefaultSuperClass)) {
      // ... but in most cases, we require that it EVENTUALLY inherits from
      // DefaultSuperClass. Can be overridden with requireDefault
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
    value: i => !!i[`_instanceOf${DefaultClass.name}`]
  });
  if (mixedInstanceOfDefault) {
    // Make instanceof DefaultClass true for anything that technically is only
    // an instanceof Mixin
    Object.defineProperty(DefaultClass, Symbol.hasInstance, {
      value: i => !!i[`_instanceOf${DefaultClass.name}`]
    });
  }
  // Return both the default class and the mixin function
  const wrapper = {};
  wrapper[DefaultClass.name] = DefaultClass;
  wrapper[DefaultClass.name + 'Mixin'] = Mixin;
  return wrapper;
};

const ThemeableMixin = function ({
  SuperClass,
  defaultStyle, // Raw text of default stylesheet
  className, // AKA "module" in SMACSS style; themed views should namespace all their default styles with this string
  defaultSheetType = 'css',
  cnNotOnD3el = false // By default, Themed views will have the className set as a class name on the view's d3el; this prevents that
}) {
  if (SuperClass instanceof ThemeableMixin) {
    SuperClass.prototype._defaultThemeSheets[className] = {
      sheet: defaultStyle,
      type: defaultSheetType,
      cnNotOnD3el
    };
    return SuperClass;
  }
  class ThemeableView extends SuperClass {
    constructor (options = {}) {
      // setting theme to null prevents the default stylesheet from loading
      // (for themes that want to build their styles from scratch)
      if (options.theme !== null) {
        options.resources = options.resources || [];
        for (const { sheet, type } of Object.values(ThemeableView.prototype._defaultThemeSheets)) {
          const resource = { type, raw: sheet };
          // leaving theme as undefined applies the default stylesheet, but
          // no overrides (for no theme, or themes that only want to override
          // the defaults after the fact)
          if (options.theme) {
            // Setting theme as an object allows themes to override less or CSS
            // variables from javascript. Note that the appropriate @ or --
            // prefixes are still required
            if (type === 'less') {
              resource.lessArgs = { modifyVars: options.theme };
            } else {
              resource.then = () => {
                const root = document.documentElement;
                for (const [cssVar, override] of Object.entries(options.theme)) {
                  root.style.setProperty(cssVar, override);
                }
              };
            }
          }
          options.resources.push(resource);
        }
      }
      super(options);
    }
    setup () {
      super.setup(...arguments);
      for (const [className, { cnNotOnD3el }] of Object.entries(ThemeableView.prototype._defaultThemeSheets)) {
        if (cnNotOnD3el === false) {
          // The className applies to the view's d3el
          this.d3el.classed(className, true);
        }
      }
    }
  }
  ThemeableView.prototype._instanceOfThemeableMixin = true;
  ThemeableView.prototype._defaultThemeSheets = {};
  ThemeableView.prototype._defaultThemeSheets[className] = {
    sheet: defaultStyle,
    type: defaultSheetType,
    cnNotOnD3el
  };
  return ThemeableView;
};
Object.defineProperty(ThemeableMixin, Symbol.hasInstance, {
  value: i => !!i._instanceOfThemeableMixin
});

var defaultStyle = "/*\nCurrent color scheme\n\nUsing ColorBrewer schemes:\nhttp://colorbrewer2.org/#type=qualitative&scheme=Dark2&n=8\nhttp://colorbrewer2.org/#type=qualitative&scheme=Pastel2&n=8\n*/\n/*\nColor meanings:\n*/\n/*\nDummy class that exposes colors for assignment to classes in Javascript:\n*/\n.classColorList {\n  filter: url(#recolorImageTo1B9E77);\n  filter: url(#recolorImageToD95F02);\n  filter: url(#recolorImageTo7570B3);\n  filter: url(#recolorImageToE7298A);\n  filter: url(#recolorImageTo66A61E);\n  filter: url(#recolorImageToE6AB02);\n  filter: url(#recolorImageToA6761D);\n  filter: url(#recolorImageToB3E2CD);\n  filter: url(#recolorImageToFDCDAC);\n  filter: url(#recolorImageToCBD5E8);\n  filter: url(#recolorImageToF4CAE4);\n  filter: url(#recolorImageToE6F5C9);\n  filter: url(#recolorImageToFFF2AE);\n  filter: url(#recolorImageToF1E2CC);\n}\n/*\nGradients:\n*/\n.GLRootView .lm_goldenlayout {\n  background: transparent;\n}\n.GLRootView .lm_content {\n  background: #F7F7F7;\n  border: 1px solid #BDBDBD;\n}\n.GLRootView .lm_dragProxy .lm_content {\n  box-shadow: 2px 2px 4px rgba(37, 37, 37, 0.2);\n}\n.GLRootView .lm_dropTargetIndicator {\n  box-shadow: inset 0 0 30px rgba(37, 37, 37, 0.4);\n  outline: 1px dashed #BDBDBD;\n}\n.GLRootView .lm_dropTargetIndicator .lm_inner {\n  background: #252525;\n  opacity: 0.1;\n}\n.GLRootView .lm_splitter {\n  background: #BDBDBD;\n  opacity: 0.001;\n  transition: opacity 200ms ease;\n}\n.GLRootView .lm_splitter:hover,\n.GLRootView .lm_splitter.lm_dragging {\n  background: #BDBDBD;\n  opacity: 1;\n}\n.GLRootView .lm_header {\n  height: 20px;\n}\n.GLRootView .lm_header .lm_tab {\n  font-family: Arial, sans-serif;\n  font-size: 12px;\n  color: #525252;\n  background: #D9D9D9;\n  margin-right: 2px;\n  padding-bottom: 4px;\n  border: 1px solid #BDBDBD;\n  border-bottom: none;\n}\n.GLRootView .lm_header .lm_tab .lm_title {\n  padding-top: 1px;\n}\n.GLRootView .lm_header .lm_tab .lm_close_tab {\n  width: 11px;\n  height: 11px;\n  background-image: url(\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAkAAAAJCAYAAADgkQYQAAAAKUlEQVR4nGNgYGD4z4Af/Mdg4FKASwCnDf8JKSBoAtEmEXQTQd8RDCcA6+4Q8OvIgasAAAAASUVORK5CYII=\");\n  background-position: center center;\n  background-repeat: no-repeat;\n  top: 4px;\n  right: 6px;\n  opacity: 0.4;\n}\n.GLRootView .lm_header .lm_tab .lm_close_tab:hover {\n  opacity: 1;\n}\n.GLRootView .lm_header .lm_tab.lm_active {\n  border-bottom: none;\n  box-shadow: 2px -2px 2px -2px rgba(37, 37, 37, 0.2);\n  padding-bottom: 5px;\n}\n.GLRootView .lm_header .lm_tab.lm_active .lm_close_tab {\n  opacity: 1;\n}\n.GLRootView .lm_dragProxy.lm_right .lm_header .lm_tab.lm_active,\n.GLRootView .lm_stack.lm_right .lm_header .lm_tab.lm_active {\n  box-shadow: 2px -2px 2px -2px rgba(37, 37, 37, 0.2);\n}\n.GLRootView .lm_dragProxy.lm_bottom .lm_header .lm_tab.lm_active,\n.GLRootView .lm_stack.lm_bottom .lm_header .lm_tab.lm_active {\n  box-shadow: 2px 2px 2px -2px rgba(37, 37, 37, 0.2);\n}\n.GLRootView .lm_selected .lm_header {\n  background-color: #452500;\n}\n.GLRootView .lm_tab:hover,\n.GLRootView .lm_tab.lm_active {\n  background: #F7F7F7;\n  color: #252525;\n}\n.GLRootView .lm_header .lm_controls .lm_tabdropdown:before {\n  color: #252525;\n}\n.GLRootView .lm_controls > li {\n  position: relative;\n  background-position: center center;\n  background-repeat: no-repeat;\n  opacity: 0.4;\n  transition: opacity 300ms ease;\n}\n.GLRootView .lm_controls > li:hover {\n  opacity: 1;\n}\n.GLRootView .lm_controls .lm_popout {\n  background-image: url(\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAkAAAAJCAYAAADgkQYQAAAANUlEQVR4nI2QMQoAMAwCz5L/f9mOzZIaN0E9UDyZhaaQz6atgBHgambEJ5wBKoS0WaIvfT+6K2MIECN19MAAAAAASUVORK5CYII=\");\n}\n.GLRootView .lm_controls .lm_maximise {\n  background-image: url(\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAkAAAAJCAYAAADgkQYQAAAAIklEQVR4nGNkYGD4z0AAMBFSAAOETPpPlEmDUREjAxHhBABPvAQLFv3qngAAAABJRU5ErkJggg==\");\n}\n.GLRootView .lm_controls .lm_close {\n  background-image: url(\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAkAAAAJCAYAAADgkQYQAAAAKUlEQVR4nGNgYGD4z4Af/Mdg4FKASwCnDf8JKSBoAtEmEXQTQd8RDCcA6+4Q8OvIgasAAAAASUVORK5CYII=\");\n}\n.GLRootView .lm_controls .lm_dock {\n  background-image: url(\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAIGNIUk0AAHolAACAgwAA+f8AAIDpAAB1MAAA6mAAADqYAAAXb5JfxUYAAAC6SURBVHjavNRRFYIwFAbgLwJRaCBRaCIRbGAEaSARaKANpMF8GedM3BSV4wMvY/u4+++GEIItns8m0/wMoUHA8WsIFS7oMOawtVCPPkGfsFeLa+ywx4RqUeEDVgIuMY8R11zIcZthfpfLYsKQVpCZc1p+oFTRhLbQuVvMrHqbUQmLVXQftT/JoE3GhtKhLCFtRLq5sphNQL0KSpB2sc0zrquuyBLJZFa/hUpI2vZVtx+HErL5b+Qv0H0Axmb86JFNd6MAAAAASUVORK5CYII=\");\n  transform: rotate(-45deg);\n  transition: transform 300ms;\n}\n.GLRootView .lm_stack.lm_docked .lm_controls .lm_dock {\n  transform: rotate(0deg);\n}\n.GLRootView .lm_stack.lm_docked > .lm_items {\n  border-color: #BDBDBD;\n  border-image: linear-gradient(to right, #BDBDBD 1%, white 100%);\n  box-shadow: 2px 2px 2px -2px rgba(37, 37, 37, 0.2);\n}\n.GLRootView .lm_maximised .lm_header {\n  background-color: white;\n}\n.GLRootView .lm_maximised .lm_controls .lm_maximise {\n  background-image: url(\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAkAAAAJCAYAAADgkQYQAAAAJklEQVR4nGP8//8/AyHARFDFUFbEwsDAwMDIyIgzHP7//89IlEkApSkHEScJTKoAAAAASUVORK5CYII=\");\n}\n.GLRootView .lm_transition_indicator {\n  background-color: #252525;\n  border: 1px dashed #BDBDBD;\n}\n.GLRootView .lm_popin {\n  cursor: pointer;\n}\n.GLRootView .lm_popin .lm_bg {\n  background: #252525;\n  opacity: 0.7;\n}\n.GLRootView .lm_popin .lm_icon {\n  background-image: url(\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA0AAAAJCAYAAADpeqZqAAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAB3RJTUUH5AIMBA8Y4uozqQAAAB1pVFh0Q29tbWVudAAAAAAAQ3JlYXRlZCB3aXRoIEdJTVBkLmUHAAAAQ0lEQVQY072OMQ6AMAzEzhH//7I7oKKKoSULXjI5Z5KokgXAbEANoMq8WwGs3FOcvq/Ul5w311zqSNVdefJ+kUjSzhteChsRI/jXegAAAABJRU5ErkJggg==\");\n  background-position: center center;\n  background-repeat: no-repeat;\n  opacity: 0.7;\n}\n.GLRootView .lm_popin:hover .lm_icon {\n  opacity: 1;\n}\n";

/* globals GoldenLayout */

const { GLRootView, GLRootViewMixin } = createMixinAndDefault({
  DefaultSuperClass: View,
  classDefFunc: SuperClass => {
    class GLRootView extends ThemeableMixin({
      SuperClass, defaultStyle, className: 'GLRootView'
    }) {
      constructor (options) {
        options.resources = options.resources || [];

        // Core CSS Styles
        if (options.glCoreStyleResource) {
          options.resources.unshift(options.glCoreStyleResource);
        } else {
          options.resources.unshift({
            'type': 'css',
            'url': 'https://golden-layout.com/files/latest/css/goldenlayout-base.css'
          });
        }

        // JS Dependencies if they aren't already loaded
        if (!window.jQuery) {
          options.resources.push({
            type: 'js',
            url: 'https://code.jquery.com/jquery-3.4.1.min.js',
            extraAttributes: {
              integrity: 'sha256-CSXorXvZcTkaix6Yvo6HppcZGetbYMGWSFlBw8HfCJo=',
              crossorigin: 'anonymous'
            },
            name: 'jQuery'
          });
        }
        if (!window.GoldenLayout) {
          options.resources.push({
            type: 'js',
            url: 'https://golden-layout.com/files/latest/js/goldenlayout.min.js',
            loadAfter: ['jQuery']
          });
        }
        options.suppressInitialRender = true;
        super(options);

        this.glSettings = options.glSettings;
        this.viewClassLookup = options.viewClassLookup;
        this.ready.then(() => {
          this.setupLayout();
          this.render();
        });
      }
      setupLayout () {
        this.goldenLayout = new GoldenLayout(this.glSettings, this.d3el.node());
        this.views = {};
        for (const [className, ViewClass] of Object.entries(this.viewClassLookup)) {
          const self = this;
          this.goldenLayout.registerComponent(className, function (container, state) {
            const view = new ViewClass({
              glContainer: container,
              glState: state
            });
            self.views[className] = view;
          });
        }
        window.addEventListener('resize', () => {
          this.goldenLayout.updateSize();
          this.render();
        });
      }
      setup () {
        super.setup(...arguments);
        // Don't do init() until setup() because GoldenLayout sometimes misbehaves
        // if LESS hasn't finished loading
        this.goldenLayout.init();
        this.renderAllViews();
      }
      draw () {
        super.draw(...arguments);
        this.renderAllViews();
      }
      renderAllViews () {
        for (const view of Object.values(this.views)) {
          view.render();
        }
      }
    }
    return GLRootView;
  }
});

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

var defaultStyle$1 = "/*\nCurrent color scheme\n\nUsing ColorBrewer schemes:\nhttp://colorbrewer2.org/#type=qualitative&scheme=Dark2&n=8\nhttp://colorbrewer2.org/#type=qualitative&scheme=Pastel2&n=8\n*/\n/*\nColor meanings:\n*/\n/*\nDummy class that exposes colors for assignment to classes in Javascript:\n*/\n.classColorList {\n  filter: url(#recolorImageTo1B9E77);\n  filter: url(#recolorImageToD95F02);\n  filter: url(#recolorImageTo7570B3);\n  filter: url(#recolorImageToE7298A);\n  filter: url(#recolorImageTo66A61E);\n  filter: url(#recolorImageToE6AB02);\n  filter: url(#recolorImageToA6761D);\n  filter: url(#recolorImageToB3E2CD);\n  filter: url(#recolorImageToFDCDAC);\n  filter: url(#recolorImageToCBD5E8);\n  filter: url(#recolorImageToF4CAE4);\n  filter: url(#recolorImageToE6F5C9);\n  filter: url(#recolorImageToFFF2AE);\n  filter: url(#recolorImageToF1E2CC);\n}\n/*\nGradients:\n*/\n.GLView.scrollArea {\n  position: absolute;\n  top: 0.25em;\n  left: 0.25em;\n  right: 0.25em;\n  bottom: 0.25em;\n  overflow: auto;\n}\n";

/* globals d3 */

const { GLView, GLViewMixin } = createMixinAndDefault({
  DefaultSuperClass: View,
  classDefFunc: SuperClass => {
    class GLView extends IntrospectableMixin(ThemeableMixin({
      SuperClass, defaultStyle: defaultStyle$1, className: 'GLView'
    })) {
      constructor (options) {
        super(options);
        this.glContainer = options.glContainer;
        this.state = options.glState;
        this.isHidden = false;
        this.glContainer.on('tab', tab => {
          this.glTabEl = d3.select(tab.element[0]);
          this.setupTab();

          // GoldenLayout creates a separate DragProxy element that needs our
          // custom tab modifications while dragging
          tab._dragListener.on('dragStart', () => {
            const draggedTabElement = d3.select('.lm_dragProxy .lm_tab');
            this.setupTab(draggedTabElement);
            this.drawTab(draggedTabElement);
          });
        });
        this.glContainer.on('open', () => {
          this.glEl = d3.select(this.glContainer.getElement()[0]);
          const d3el = this.setupD3El();
          this.render(d3el);
        });
        this.glContainer.on('hide', () => {
          this.isHidden = true;
        });
        this.glContainer.on('show', () => {
          this.isHidden = false;
          this.render();
        });
        this.glContainer.on('resize', () => this.render());
      }
      get title () {
        return this.humanReadableType;
      }
      setupTab () {
        this.glTabEl.classed(this.type, true);
      }
      drawTab () {
        this.glTabEl.select(':scope > .lm_title')
          .text(this.title);
      }
      setupD3El () {
        // Default setup is a scrollable div; subclasses might override this
        return this.glEl.append('div')
          .classed('scrollArea', true);
      }
      getAvailableSpace (content = this.d3el) {
        return content.node().getBoundingClientRect();
      }
      draw () {
        super.draw(...arguments);
        if (this.glTabEl) {
          this.drawTab();
        }
      }
    }
    return GLView;
  }
});

/* globals d3 */

const { ParentSizeView, ParentSizeViewMixin } = createMixinAndDefault({
  DefaultSuperClass: View,
  classDefFunc: SuperClass => {
    class ParentSizeView extends SuperClass {
      getBounds (parent = d3.select(this.d3el.node().parentNode)) {
        // Temporarily set this element's size to 0,0 so that it doesn't influence
        // it's parent's natural size
        const previousBounds = {
          width: this.d3el.attr('width'),
          height: this.d3el.attr('height')
        };
        this.d3el
          .attr('width', 0)
          .attr('height', 0);
        const bounds = parent.node().getBoundingClientRect();
        // Restore the bounds
        this.d3el
          .attr('width', previousBounds.width)
          .attr('height', previousBounds.height);
        return bounds;
      }
      draw () {
        super.draw(...arguments);
        const bounds = this.getBounds();
        this.d3el
          .attr('width', bounds.width)
          .attr('height', bounds.height);
      }
    }
    return ParentSizeView;
  }
});

/* globals d3 */

const { SvgView, SvgViewMixin } = createMixinAndDefault({
  DefaultSuperClass: View,
  classDefFunc: SuperClass => {
    class SvgView extends ParentSizeViewMixin(SuperClass) {
      constructor (options) {
        options.fixedTagType = 'svg';
        super(options);
      }
      download () {
        // Adapted from https://stackoverflow.com/a/37387449/1058935
        const containerElements = ['svg', 'g'];
        const relevantStyles = {
          'svg': ['width', 'height'],
          'rect': ['fill', 'stroke', 'stroke-width', 'opacity'],
          'p': ['font', 'opacity'],
          '.node': ['cursor', 'opacity'],
          'path': ['fill', 'stroke', 'stroke-width', 'opacity'],
          'circle': ['fill', 'stroke', 'stroke-width', 'opacity'],
          'line': ['stroke', 'stroke-width', 'opacity'],
          'text': ['fill', 'font-size', 'text-anchor', 'opacity'],
          'polygon': ['stroke', 'fill', 'opacity']
        };
        const copyStyles = (original, copy) => {
          const tagName = original.tagName;
          const allStyles = window.getComputedStyle(original);
          for (const style of relevantStyles[tagName] || []) {
            d3.select(copy).style(style, allStyles[style]);
          }
          if (containerElements.indexOf(tagName) !== -1) {
            for (let i = 0; i < original.children.length; i++) {
              copyStyles(original.children[i], copy.children[i]);
            }
          }
        };

        const original = this.d3el.node();
        const copy = original.cloneNode(true);
        copyStyles(original, copy);

        const data = new window.XMLSerializer().serializeToString(copy);
        const svg = new window.Blob([data], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svg);

        const link = d3.select('body')
          .append('a')
          .attr('download', `${this.title}.svg`)
          .attr('href', url);
        link.node().click();
        link.remove();
      }
    }
    return SvgView;
  }
});

var defaultStyle$2 = ".SvgGLTab {\n  padding-right: 36px;\n}\n.SvgGLTab .downloadIcon {\n  position: absolute;\n  width: 11px;\n  height: 11px;\n  background-image: url(\"data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiPz4KPCEtLSBHZW5lcmF0b3I6IEFkb2JlIElsbHVzdHJhdG9yIDE5LjIuMSwgU1ZHIEV4cG9ydCBQbHVnLUluIC4gU1ZHIFZlcnNpb246IDYuMDAgQnVpbGQgMCkgIC0tPgo8c3ZnIHZlcnNpb249IjEuMSIgaWQ9IkxheWVyXzEiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiIHg9IjBweCIgeT0iMHB4IgoJIHZpZXdCb3g9IjAgMCA1MTIgNTEyIiBzdHlsZT0iZW5hYmxlLWJhY2tncm91bmQ6bmV3IDAgMCA1MTIgNTEyOyIgeG1sOnNwYWNlPSJwcmVzZXJ2ZSI+CjxzdHlsZSB0eXBlPSJ0ZXh0L2NzcyI+Cgkuc3Qwe2ZpbGw6IzAwMDAwMDt9Cjwvc3R5bGU+CjxnPgoJPHBhdGggY2xhc3M9InN0MCIgZD0iTTYsMzU4LjVjNy43LTIxLjIsMTQuNC0yNS44LDM3LjQtMjUuOGM0MS40LDAsODIuOC0wLjEsMTI0LjIsMC4yYzQuMSwwLDksMi4yLDEyLDVjMTEuMywxMC42LDIyLDIxLjksMzMsMzIuOQoJCWMyNi4zLDI2LjEsNjAuMywyNi4yLDg2LjcsMC4xYzExLjItMTEuMSwyMi4xLTIyLjUsMzMuNy0zMy4zYzIuOC0yLjcsNy41LTQuNywxMS40LTQuN2M0MS40LTAuMyw4Mi44LTAuMiwxMjQuMi0wLjIKCQljMjMuMSwwLDI5LjcsNC42LDM3LjQsMjUuOGMwLDM0LjIsMCw2OC4zLDAsMTAyLjVjLTcuNywyMC44LTE0LjIsMjUuMS0zNywyNS4xYy0xNDIsMC0yODQsMC00MjYsMGMtMjIuOCwwLTI5LjMtNC40LTM3LTI1LjEKCQlDNiw0MjYuOCw2LDM5Mi43LDYsMzU4LjV6IE0zOTAsNDI4LjZjLTAuMS0xMC4xLTguNi0xOC43LTE4LjYtMTguOWMtMTAuMi0wLjItMTkuMyw4LjktMTkuMiwxOS4xYzAuMSwxMC40LDkuMSwxOSwxOS41LDE4LjcKCQlDMzgxLjgsNDQ3LjMsMzkwLjEsNDM4LjcsMzkwLDQyOC42eiBNNDQ3LjksNDQ3LjdjOS45LDAsMTguOC04LjcsMTkuMS0xOC42YzAuMy0xMC05LTE5LjQtMTkuMS0xOS40Yy0xMC4xLDAtMTkuMyw5LjQtMTkuMSwxOS40CgkJQzQyOS4xLDQzOSw0MzgsNDQ3LjcsNDQ3LjksNDQ3Ljd6Ii8+Cgk8cGF0aCBjbGFzcz0ic3QwIiBkPSJNMzEzLjUsMTc5LjNjMTkuOSwwLDM4LjgsMCw1Ny42LDBjNS40LDAsMTAuOSwwLjEsMTYuMywwYzkuNC0wLjMsMTYuNywyLjgsMjAuNiwxMS45CgkJYzMuOSw5LjMsMC40LDE2LjMtNi4zLDIyLjljLTQxLjEsNDAuOS04Miw4MS45LTEyMywxMjIuOWMtMjAuMywyMC4zLTI1LjIsMjAuMy00NS40LDAuMWMtNDAuOC00MC44LTgxLjYtODEuNi0xMjIuNS0xMjIuMwoJCWMtNi43LTYuNy0xMS0xMy42LTctMjMuNGMzLjctOC44LDEwLjUtMTIuMSwxOS43LTEyLjFjMjIsMC4xLDQ0LDAsNjYsMGMyLjgsMCw1LjUsMCw4LjksMGMwLTMuOSwwLTYuNywwLTkuNQoJCWMwLTQwLjEsMC04MC4yLDAtMTIwLjNjMC0xNi40LDcuMi0yMy41LDIzLjctMjMuNmMyMi44LTAuMSw0NS41LTAuMSw2OC4zLDBjMTUuOSwwLjEsMjMsNy40LDIzLjEsMjMuNGMwLDQwLjEsMCw4MC4yLDAsMTIwLjMKCQlDMzEzLjUsMTcyLjUsMzEzLjUsMTc1LjMsMzEzLjUsMTc5LjN6Ii8+CjwvZz4KPC9zdmc+Cg==\");\n  background-position: center center;\n  background-repeat: no-repeat;\n  background-size: 11px 11px;\n  top: 4px;\n  right: 6px;\n  margin-right: 13px;\n  opacity: 0.4;\n}\n.SvgGLTab .downloadIcon:hover {\n  opacity: 1;\n}\n";

/* globals d3 */

const { SvgGLView, SvgGLViewMixin } = createMixinAndDefault({
  DefaultSuperClass: GLView,
  classDefFunc: SuperClass => {
    class SvgGLView extends SvgViewMixin(ThemeableMixin({
      SuperClass, defaultStyle: defaultStyle$2, className: 'SvgGLView', cnNotOnD3el: true
    })) {
      setupD3El () {
        return this.glEl.append('svg')
          .attr('src', this.src)
          .on('load', () => { this.trigger('viewLoaded'); });
      }
      setupTab () {
        super.setupTab();
        this.glTabEl
          .classed('SvgGLTab', true)
          .append('div')
          .classed('downloadIcon', true)
          .attr('title', 'Download')
          .on('mousedown', () => {
            d3.event.stopPropagation();
          })
          .on('mouseup', () => {
            this.download();
          });
      }
    }
    return SvgGLView;
  }
});

const { IFrameView, IFrameViewMixin } = createMixinAndDefault({
  DefaultSuperClass: View,
  classDefFunc: SuperClass => {
    class IFrameView extends ParentSizeViewMixin(SuperClass) {
      constructor (options) {
        super(options);
        this._src = options.src;
        this.frameLoaded = !this._src; // We are loaded if no src is initially provided
      }
      setup () {
        super.setup(...arguments);
        this.d3el
          .on('load', () => { this.trigger('viewLoaded'); })
          .attr('src', this.src);
      }
      get src () {
        return this._src;
      }
      set src (src) {
        this.frameLoaded = !src;
        this._src = src;
        this.d3el.select('iframe')
          .attr('src', this._src);
        this.render();
      }
      get isLoading () {
        return super.isLoading || !this.frameLoaded;
      }
      openAsTab () {
        window.open(this._src, '_blank');
      }
    }
    return IFrameView;
  }
});

var defaultStyle$3 = ".IFrameGLTab {\n  padding-right: 36px;\n}\n.IFrameGLTab .linkIcon {\n  position: absolute;\n  width: 11px;\n  height: 11px;\n  background-image: url(\"data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9Im5vIj8+CjwhLS0gQ3JlYXRlZCB3aXRoIElua3NjYXBlIChodHRwOi8vd3d3Lmlua3NjYXBlLm9yZy8pIC0tPgoKPHN2ZwogICB4bWxuczpkYz0iaHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS8iCiAgIHhtbG5zOmNjPSJodHRwOi8vY3JlYXRpdmVjb21tb25zLm9yZy9ucyMiCiAgIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyIKICAgeG1sbnM6c3ZnPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIKICAgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIgogICB4bWxuczpzb2RpcG9kaT0iaHR0cDovL3NvZGlwb2RpLnNvdXJjZWZvcmdlLm5ldC9EVEQvc29kaXBvZGktMC5kdGQiCiAgIHhtbG5zOmlua3NjYXBlPSJodHRwOi8vd3d3Lmlua3NjYXBlLm9yZy9uYW1lc3BhY2VzL2lua3NjYXBlIgogICB3aWR0aD0iNTEyIgogICBoZWlnaHQ9IjUxMiIKICAgdmlld0JveD0iMCAwIDUxMiA1MTIiCiAgIHZlcnNpb249IjEuMSIKICAgaWQ9InN2ZzgiCiAgIGlua3NjYXBlOnZlcnNpb249IjAuOTIuNCAoNWRhNjg5YzMxMywgMjAxOS0wMS0xNCkiCiAgIHNvZGlwb2RpOmRvY25hbWU9Imxpbmsuc3ZnIj4KICA8ZGVmcwogICAgIGlkPSJkZWZzMiIgLz4KICA8c29kaXBvZGk6bmFtZWR2aWV3CiAgICAgaWQ9ImJhc2UiCiAgICAgcGFnZWNvbG9yPSIjZmZmZmZmIgogICAgIGJvcmRlcmNvbG9yPSIjNjY2NjY2IgogICAgIGJvcmRlcm9wYWNpdHk9IjEuMCIKICAgICBpbmtzY2FwZTpwYWdlb3BhY2l0eT0iMC4wIgogICAgIGlua3NjYXBlOnBhZ2VzaGFkb3c9IjIiCiAgICAgaW5rc2NhcGU6em9vbT0iMC43IgogICAgIGlua3NjYXBlOmN4PSI5NTEuNjcyNDQiCiAgICAgaW5rc2NhcGU6Y3k9Ijg3OS4zMDQ2OSIKICAgICBpbmtzY2FwZTpkb2N1bWVudC11bml0cz0icHgiCiAgICAgaW5rc2NhcGU6Y3VycmVudC1sYXllcj0ibGF5ZXIxIgogICAgIHNob3dncmlkPSJ0cnVlIgogICAgIHVuaXRzPSJweCIKICAgICBpbmtzY2FwZTp3aW5kb3ctd2lkdGg9IjMzNjAiCiAgICAgaW5rc2NhcGU6d2luZG93LWhlaWdodD0iMTc4MCIKICAgICBpbmtzY2FwZTp3aW5kb3cteD0iNzAzMCIKICAgICBpbmtzY2FwZTp3aW5kb3cteT0iLTEyIgogICAgIGlua3NjYXBlOndpbmRvdy1tYXhpbWl6ZWQ9IjEiCiAgICAgaW5rc2NhcGU6cGFnZWNoZWNrZXJib2FyZD0iZmFsc2UiPgogICAgPGlua3NjYXBlOmdyaWQKICAgICAgIHR5cGU9Inh5Z3JpZCIKICAgICAgIGlkPSJncmlkMTM1OCIKICAgICAgIHNwYWNpbmd4PSIyMCIKICAgICAgIHNwYWNpbmd5PSIyMCIgLz4KICA8L3NvZGlwb2RpOm5hbWVkdmlldz4KICA8bWV0YWRhdGEKICAgICBpZD0ibWV0YWRhdGE1Ij4KICAgIDxyZGY6UkRGPgogICAgICA8Y2M6V29yawogICAgICAgICByZGY6YWJvdXQ9IiI+CiAgICAgICAgPGRjOmZvcm1hdD5pbWFnZS9zdmcreG1sPC9kYzpmb3JtYXQ+CiAgICAgICAgPGRjOnR5cGUKICAgICAgICAgICByZGY6cmVzb3VyY2U9Imh0dHA6Ly9wdXJsLm9yZy9kYy9kY21pdHlwZS9TdGlsbEltYWdlIiAvPgogICAgICAgIDxkYzp0aXRsZT48L2RjOnRpdGxlPgogICAgICA8L2NjOldvcms+CiAgICA8L3JkZjpSREY+CiAgPC9tZXRhZGF0YT4KICA8ZwogICAgIGlua3NjYXBlOmxhYmVsPSJMYXllciAxIgogICAgIGlua3NjYXBlOmdyb3VwbW9kZT0ibGF5ZXIiCiAgICAgaWQ9ImxheWVyMSIKICAgICB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLC01NzkuMjUwMDEpIj4KICAgIDxnCiAgICAgICBpZD0iZzgzNyIKICAgICAgIHRyYW5zZm9ybT0ibWF0cml4KDEuOTI0NDY4OSwwLDAsMS45MjQ0Njg5LC0yMDMzLjI4ODQsLTgxNC45NDQ5MikiCiAgICAgICBzdHlsZT0ic3Ryb2tlLXdpZHRoOjAuNTE5NjIzODgiPgogICAgICA8cGF0aAogICAgICAgICBpZD0icGF0aDgzMSIKICAgICAgICAgZD0ibSAxMjc3LjcyOTgsOTg1LjEwMjIxIGMgNS44NzU0LC0yLjI2NzIxIDEwLjA1OTMsLTYuNDczOTEgMTIuMTA5NiwtMTIuMTc1NTkgMS41NzA2LC00LjM2NzcxIDEuNzAzMiwtOS42MjAwNCAxLjQ0NDksLTU3LjI0Mjc5IC0wLjI3NjgsLTUxLjA1MTY1IC0wLjMzOTEsLTUyLjUyNjA4IC0yLjM2NCwtNTUuOTMzODIgLTEuMTQzOCwtMS45MjUgLTMuOTkxMywtNC45NjI1IC02LjMyNzcsLTYuNzUgLTMuNzQ2MiwtMi44NjYgLTQuOTc3NCwtMy4yNDc0MSAtMTAuNDIwMywtMy4yMjgwNCAtOC4zMDE0LDAuMDI5NSAtMTMuNzQ1NSwyLjU4NTc0IC0xNy4zNjE4LDguMTUyMDYgbCAtMi44MTA1LDQuMzI1OTggLTAuMzA5Miw0Mi4yNSAtMC4zMDkzLDQyLjI1IEggMTE3NS40NDA4IDEwOTkuNSB2IC03Ni41IC03Ni41IGwgMzguNzUsLTAuMDA2IGMgMjMuNTY5NywtMC4wMDMgNDAuMjA2OSwtMC40MTAxOSA0Mi40Njg5LC0xLjAzODQzIDE4LjYxMDEsLTUuMTY4NTIgMTguMDg2OSwtMzIuNzE1MjkgLTAuNzE4OSwtMzcuODUyMjEgLTUuOTM3NSwtMS42MjE4NyAtMTAwLjQxMDQsLTEuNTA5NCAtMTA1Ljg4NCwwLjEyNjA2IC02LjM0MDcsMS44OTQ1NSAtMTIuMTczMyw4LjMyMDQ0IC0xMy41NDM2LDE0LjkyMTM0IC0wLjc5NCwzLjgyNDg1IC0xLjA0MDUsMzMuOTMxMTYgLTAuODQ2NCwxMDMuMzcyNjggbCAwLjI3NCw5Ny45NzY1NiAyLjUsNC40MTE0MiBjIDEuMzc1LDIuNDI2MjggMy42NTEsNS4yNjIwNyA1LjA1NzgsNi4zMDE3NyA2LjQ4OTQsNC43OTU5NSA0LjIxNTEsNC42OTYyMyAxMDguMTcyLDQuNzQyOTIgODguNDM5LDAuMDM5NyA5OC4xMzU3LC0wLjExMjc2IDEwMiwtMS42MDM5MSB6IgogICAgICAgICBzdHlsZT0iZmlsbDojMDAwMDAwO3N0cm9rZS13aWR0aDowLjUxOTYyMzg4IgogICAgICAgICBpbmtzY2FwZTpjb25uZWN0b3ItY3VydmF0dXJlPSIwIiAvPgogICAgICA8cGF0aAogICAgICAgICBpZD0icGF0aDgyNyIKICAgICAgICAgZD0ibSAxMTkxLjc5OTcsODgwLjEyOTgxIGMgMy45NjgyLC0yLjAwODkzIDExLjU1NDIsLTkuMjA4NzIgNTMuMjkyNSwtNTAuNTc5MjMgMTguMjAwNywtMTguMDQwMzEgMzMuMzg4MiwtMzIuODAwNTcgMzMuNzUsLTMyLjgwMDU3IDAuMzYxOCwwIDAuNjY3Nyw2LjQxMjUgMC42Nzk4LDE0LjI1IDAuMDI1LDE2LjE3NzcyIDEuMDI4NiwxOS42NzU5IDcuMzc5LDI1LjcxODYyIDMuMzIyMywzLjE2MTIzIDQuMjcwNCwzLjUwMzk0IDEwLjY5OTEsMy44NjcxOSA1LjI0NDMsMC4yOTYzNCA4LjA0ODYsLTAuMDUgMTAuOTMyMSwtMS4zNTAzMiA0LjY2OTcsLTIuMTA1NzggOC45MzU1LC03LjkyOTc3IDEwLjA1NzksLTEzLjczMjExIDEuMzE2NywtNi44MDY0NSAxLjEwNTcsLTc3LjA5MDI5IC0wLjI0NzYsLTgyLjQ2NDQ5IC0xLjUyMTQsLTYuMDQyMDEgLTguMDYzMSwtMTIuODI4MjcgLTEzLjQ2NjYsLTEzLjk2OTk1IC0yLjEzMTcsLTAuNDUwNDIgLTIyLjEwMDksLTAuODE4OTQgLTQ0LjM3NTksLTAuODE4OTQgSCAxMjIwIGwgLTQuNDU1NiwyLjUgYyAtNS42NDksMy4xNjk2NCAtOS44NTUxLDkuMTQzOCAtMTAuNjYyNSwxNS4xNDQ3NCAtMC44OTMzLDYuNjM5NTIgMi44ODE0LDE0LjY3NjkzIDguNzAzNiwxOC41MzIzOCA0LjE0MjIsMi43NDI5MyA0LjcyODgsMi44MzcwNCAyMC43MTQ5LDMuMzIyODggbCAxNi40NTIsMC41IC00MS43Njc3LDQxIGMgLTQzLjgzMDcsNDMuMDI1IC00NS41MTI3LDQ0Ljk5ODE2IC00NS40NjI3LDUzLjMzMjkxIDAuMDI0LDQuMDU1ODggMi44NzAyLDExLjA5MDI3IDUuNjY5OSwxNC4wMTQ1NiA0Ljg5NDMsNS4xMTIwNyAxNi4wNDU3LDYuODU0NDIgMjIuNjA3OCwzLjUzMjMzIHoiCiAgICAgICAgIHN0eWxlPSJmaWxsOiMwMDAwMDA7c3Ryb2tlLXdpZHRoOjAuNTE5NjIzODgiCiAgICAgICAgIGlua3NjYXBlOmNvbm5lY3Rvci1jdXJ2YXR1cmU9IjAiIC8+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4K\");\n  background-position: center center;\n  background-repeat: no-repeat;\n  background-size: 11px 11px;\n  top: 4px;\n  right: 6px;\n  margin-right: 13px;\n  opacity: 0.4;\n}\n.IFrameGLTab .linkIcon:hover {\n  opacity: 1;\n}\n";

/* globals d3 */

const { IFrameGLView, IFrameGLViewMixin } = createMixinAndDefault({
  DefaultSuperClass: GLView,
  classDefFunc: SuperClass => {
    class IFrameGLView extends IFrameViewMixin(ThemeableMixin({
      SuperClass, defaultStyle: defaultStyle$3, className: 'IFrameGLView', cnNotOnD3el: true
    })) {
      setupD3El () {
        return this.glEl.append('iframe');
      }
      setupTab () {
        super.setupTab();
        this.glTabEl
          .classed('IFrameGLTab', true)
          .append('div')
          .classed('linkIcon', true)
          .attr('title', 'Open in new tab')
          .on('mousedown', () => {
            d3.event.stopPropagation();
          })
          .on('mouseup', () => {
            this.openAsTab();
          });
      }
    }
    return IFrameGLView;
  }
});

var goldenlayout = /*#__PURE__*/Object.freeze({
  __proto__: null,
  GLRootView: GLRootView,
  GLRootViewMixin: GLRootViewMixin,
  GLView: GLView,
  GLViewMixin: GLViewMixin,
  SvgGLView: SvgGLView,
  SvgGLViewMixin: SvgGLViewMixin,
  IFrameGLView: IFrameGLView,
  IFrameGLViewMixin: IFrameGLViewMixin
});

/* globals gapi */

class AuthSheetModel extends Model {
  constructor (options = {}) {
    if (!window.gapi) {
      options.resources = options.resources || [];
      options.resources.push({ type: 'js', url: 'https://apis.google.com/js/api.js' });
    }
    super(options);

    this.spreadsheetId = options.spreadsheetId;
    this.mode = options.mode || AuthSheetModel.MODE.AUTH_READ_ONLY;
    if (!AuthSheetModel.MODE[this.mode]) {
      throw new Error(`Mode ${this.mode} not supported yet`);
    }
    this.sheet = options.sheet || 'Sheet1';

    this._cache = null;
    this._status = AuthSheetModel.STATUS.PENDING;
  }
  async _initWorkaroundPromise (apiKey, clientId) {
    // Really annoying google bug: https://github.com/google/google-api-javascript-client/issues/399
    // means that we have to wait 10ms before actually trying to call init() or it fails silently
    // :rage_emoji: ... can I please have the last week of my life back?
    if (!AuthSheetModel._initPromise) {
      AuthSheetModel._initPromise = new Promise((resolve, reject) => {
        window.setTimeout(() => {
          gapi.client.init({
            apiKey: apiKey,
            clientId: clientId,
            discoveryDocs: ['https://sheets.googleapis.com/$discovery/rest?version=v4'],
            scope: this.mode === AuthSheetModel.MODE.AUTH_READ_ONLY
              ? 'https://www.googleapis.com/auth/spreadsheets.readonly'
              : 'https://www.googleapis.com/auth/spreadsheets'
          }).then(resolve, reject);
        }, 10);
      });
    }
    return AuthSheetModel._initPromise;
  }
  async setupAuth (apiKey, clientId) {
    await this.ready;

    if (this.mode === AuthSheetModel.MODE.AUTH_READ_ONLY ||
        this.mode === AuthSheetModel.MODE.AUTH_READ_WRITE) {
      gapi.load('client:auth2', async () => {
        try {
          await this._initWorkaroundPromise(apiKey, clientId);
        } catch (error) {
          this.status = AuthSheetModel.STATUS.ERROR;
          throw error;
        }

        const auth = gapi.auth2.getAuthInstance().isSignedIn;

        // Listen for status changes
        auth.listen(signedIn => {
          this.status = signedIn
            ? AuthSheetModel.STATUS.SIGNED_IN : AuthSheetModel.STATUS.SIGNED_OUT;
        });

        // Figure out our initial status
        this.status = auth.get()
          ? AuthSheetModel.STATUS.SIGNED_IN : AuthSheetModel.STATUS.SIGNED_OUT;
      });
    } else {
      this.status = AuthSheetModel.STATUS.NO_AUTH;
    }
  }
  get status () {
    return this._status;
  }
  set status (status) {
    this._status = status;
    if (this._status === AuthSheetModel.STATUS.SIGNED_IN) {
      this.updateCache();
    } else {
      this._cache = null;
      this.trigger('dataUpdated');
    }
    this.trigger('statusChanged', status);
  }
  getHeaders () {
    const rawTable = this.getRawTable();
    return rawTable.length > 0 ? rawTable[0] : [];
  }
  getValues () {
    if (!this._valueCache) {
      const headers = this.getHeaders();
      this._valueCache = this.getRawTable().slice(1).map(row => {
        const obj = {};
        for (let i = 0; i < headers.length || i < row.length; i++) {
          let header = headers[i] || 'Blank Header';
          if (obj[header] !== undefined) {
            let extraHeader = 1;
            while (obj[header + extraHeader] !== undefined) { extraHeader += 1; }
            header = header + extraHeader;
          }
          obj[header] = row[i] || '';
        }
        return obj;
      });
    }
    return this._valueCache;
  }
  getRawTable () {
    return (this._cache && this._cache.values) || [];
  }
  async addRows (rows) {
    const headers = this.getHeaders();
    const initialHeaderLength = headers.length;
    await this.addRawRows(rows.map(row => {
      const list = [];
      const temp = Object.assign({}, row);
      for (const header of headers) {
        list.push(temp[header]);
        delete temp[header];
      }
      for (const [header, value] of Object.entries(temp)) {
        headers.push(header);
        list.push(value);
      }
      return list;
    }), true);
    if (initialHeaderLength < headers.length) {
      try {
        await gapi.client.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: this.sheet + '!1:1',
          valueInputOption: 'RAW'
        }, {
          majorDimension: 'ROWS',
          values: [ headers ]
        });
      } catch (err) {
        this.status = AuthSheetModel.STATUS.ERROR;
        throw err;
      }
    }
    await this.updateCache();
  }
  async removeRows (startIndex, endIndex) {
    try {
      await gapi.client.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        resource: {
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId: 0,
                  dimension: 'ROWS',
                  startIndex,
                  endIndex
                }
              }
            }
          ]
        }
      });
    } catch (err) {
      this.status = AuthSheetModel.STATUS.ERROR;
      throw err;
    }
    await this.updateCache();
  }
  async removeColumn (colName) {
    const headers = this.getHeaders();
    const index = headers.indexOf(colName);
    if (index === -1) {
      throw new Error(`Can't remove non-existent column ${colName}`);
    }
    try {
      await gapi.client.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        resource: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId: 0,
                dimension: 'COLUMNS',
                startIndex: index,
                endIndex: index + 1
              }
            }
          }]
        }
      });
    } catch (err) {
      this.status = AuthSheetModel.STATUS.ERROR;
      throw err;
    }
    await this.updateCache();
  }
  async addRawRows (rows, skipCacheUpdate = false) {
    try {
      await gapi.client.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: this.sheet,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS'
      }, {
        majorDimension: 'ROWS',
        values: rows
      });
    } catch (err) {
      this.status = AuthSheetModel.STATUS.ERROR;
      throw err;
    }
    if (!skipCacheUpdate) {
      await this.updateCache();
    }
  }
  async updateCache () {
    try {
      const response = await gapi.client.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: this.sheet
      });
      this._cache = response.result;
      delete this._valueCache;
      this.trigger('dataUpdated');
    } catch (err) {
      this.status = AuthSheetModel.STATUS.ERROR;
      throw err;
    }
  }
  signIn () {
    if (!this.mode.startsWith('AUTH')) {
      throw new Error(`Can't sign in to model with mode ${this.mode}`);
    }
    gapi.auth2.getAuthInstance().signIn();
  }
  signOut () {
    if (!this.mode.startsWith('AUTH')) {
      throw new Error(`Can't sign out of model with mode ${this.mode}`);
    }
    gapi.auth2.getAuthInstance().signOut();
  }
}

AuthSheetModel.STATUS = {
  'SIGNED_IN': 'SIGNED_IN',
  'SIGNED_OUT': 'SIGNED_OUT',
  'ERROR': 'ERROR',
  'PENDING': 'PENDING',
  'NO_AUTH': 'NO_AUTH'
};

AuthSheetModel.MODE = {
  // 'FORM_CURATED_WRITE': 'FORM_CURATED_WRITE',
  // 'FORM_DANGEROUS_READ_WRITE': 'FORM_DANGEROUS_READ_WRITE',
  'AUTH_READ_ONLY': 'AUTH_READ_ONLY',
  'AUTH_READ_WRITE': 'AUTH_READ_WRITE'
};

var google = /*#__PURE__*/Object.freeze({
  __proto__: null,
  AuthSheetModel: AuthSheetModel
});

var defaultStyle$4 = ".LoadingSpinner {\n  position: absolute;\n  background: center / 3em no-repeat url(\"data:image/gif;base64,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\"), rgba(255, 255, 255, 0.75);\n}\n";

/* globals d3 */

const { LoadingView, LoadingViewMixin } = createMixinAndDefault({
  DefaultSuperClass: View,
  classDefFunc: SuperClass => {
    class LoadingView extends ThemeableMixin({
      SuperClass, defaultStyle: defaultStyle$4, className: 'LoadingSpinner', cnNotOnD3el: true
    }) {
      constructor (options) {
        super(options);
        this._loaded = false;
        this.on('load', () => {
          this._loaded = true;
          this.render();
        });
      }
      get isLoading () {
        return !this._loaded;
      }
      setup () {
        super.setup(...arguments);
        // Place a layer on top of this.d3el
        const parent = d3.select(this.d3el.node().parentNode);
        this.spinner = parent.append('div')
          .classed('LoadingSpinner', true)
          .style('display', 'none');
      }
      draw () {
        super.draw(...arguments);
        // Match the position / size of this.d3el
        const bounds = this.getBounds();
        const parentBounds = this.getBounds(d3.select(this.d3el.node().parentNode));
        this.spinner
          .style('top', bounds.top - parentBounds.top)
          .style('left', bounds.left - parentBounds.left)
          .style('right', bounds.right - parentBounds.right)
          .style('bottom', bounds.bottom - parentBounds.bottom)
          .style('display', this.isLoading ? null : 'none');
      }
    }
    return LoadingView;
  }
});

var defaultStyle$5 = "/*\nCurrent color scheme\n\nUsing ColorBrewer schemes:\nhttp://colorbrewer2.org/#type=qualitative&scheme=Dark2&n=8\nhttp://colorbrewer2.org/#type=qualitative&scheme=Pastel2&n=8\n*/\n/*\nColor meanings:\n*/\n/*\nDummy class that exposes colors for assignment to classes in Javascript:\n*/\n.classColorList {\n  filter: url(#recolorImageTo1B9E77);\n  filter: url(#recolorImageToD95F02);\n  filter: url(#recolorImageTo7570B3);\n  filter: url(#recolorImageToE7298A);\n  filter: url(#recolorImageTo66A61E);\n  filter: url(#recolorImageToE6AB02);\n  filter: url(#recolorImageToA6761D);\n  filter: url(#recolorImageToB3E2CD);\n  filter: url(#recolorImageToFDCDAC);\n  filter: url(#recolorImageToCBD5E8);\n  filter: url(#recolorImageToF4CAE4);\n  filter: url(#recolorImageToE6F5C9);\n  filter: url(#recolorImageToFFF2AE);\n  filter: url(#recolorImageToF1E2CC);\n}\n/*\nGradients:\n*/\n.EmptyStateLayer {\n  position: absolute;\n  width: 100%;\n  height: 100%;\n  pointer-events: none;\n}\n.EmptyStateLayer .EmptyStateLayerContent {\n  position: absolute;\n  top: 50%;\n  transform: translateY(-50%);\n  left: 0.25em;\n  right: 0.25em;\n  text-align: center;\n}\n";

/* globals d3 */

const { EmptyStateView, EmptyStateViewMixin } = createMixinAndDefault({
  DefaultSuperClass: View,
  classDefFunc: SuperClass => {
    class EmptyStateView extends ThemeableMixin({
      SuperClass, defaultStyle: defaultStyle$5, className: 'EmptyStateLayer', cnNotOnD3el: true
    }) {
      get emptyMessage () {
        // Should be overridden by subclasses; return an html string (or falsey to
        // hide the empty state layer)
        return '';
      }
      setup () {
        super.setup(...arguments);
        // Insert a layer underneath this.d3el
        const node = this.d3el.node();
        const parentNode = node.parentNode;
        const wrapperNode = document.createElement('div');
        parentNode.insertBefore(wrapperNode, node);
        this.emptyStateWrapper = d3.select(wrapperNode)
          .classed('EmptyStateLayer', true)
          .style('display', 'none');
        this.emptyStateContent = this.emptyStateWrapper.append('div')
          .classed('EmptyStateLayerContent', true);
      }
      draw () {
        super.draw(...arguments);
        const message = this.emptyMessage;
        // Match the position / size of this.d3el
        const bounds = this.getBounds();
        const parentBounds = this.getBounds(d3.select(this.d3el.node().parentNode));
        this.emptyStateContent.html(message);
        this.emptyStateWrapper
          .style('top', bounds.top - parentBounds.top)
          .style('left', bounds.left - parentBounds.left)
          .style('right', bounds.right - parentBounds.right)
          .style('bottom', bounds.bottom - parentBounds.bottom)
          .style('display', message ? null : 'none');
      }
    }
    return EmptyStateView;
  }
});

var defaultStyle$6 = "/*\nCurrent color scheme\n\nUsing ColorBrewer schemes:\nhttp://colorbrewer2.org/#type=qualitative&scheme=Dark2&n=8\nhttp://colorbrewer2.org/#type=qualitative&scheme=Pastel2&n=8\n*/\n/*\nColor meanings:\n*/\n/*\nDummy class that exposes colors for assignment to classes in Javascript:\n*/\n.classColorList {\n  filter: url(#recolorImageTo1B9E77);\n  filter: url(#recolorImageToD95F02);\n  filter: url(#recolorImageTo7570B3);\n  filter: url(#recolorImageToE7298A);\n  filter: url(#recolorImageTo66A61E);\n  filter: url(#recolorImageToE6AB02);\n  filter: url(#recolorImageToA6761D);\n  filter: url(#recolorImageToB3E2CD);\n  filter: url(#recolorImageToFDCDAC);\n  filter: url(#recolorImageToCBD5E8);\n  filter: url(#recolorImageToF4CAE4);\n  filter: url(#recolorImageToE6F5C9);\n  filter: url(#recolorImageToFFF2AE);\n  filter: url(#recolorImageToF1E2CC);\n}\n/*\nGradients:\n*/\n.UkiButton {\n  position: relative;\n  min-width: 2.5em;\n  min-height: 2.5em;\n  width: -webkit-fit-content;\n  height: -webkit-fit-content;\n  width: fit-content;\n  height: fit-content;\n  background: white;\n  border-radius: 0.5em;\n  display: flex;\n  align-items: center;\n  flex-wrap: nowrap;\n  justify-content: space-around;\n  cursor: pointer;\n  user-select: none;\n}\n.UkiButton.small {\n  min-width: 1.5em;\n  min-height: 1.5em;\n}\n.UkiButton.tiny {\n  min-width: 1em;\n  min-height: 1em;\n}\n.UkiButton a {\n  position: absolute;\n  left: 0px;\n  top: 0px;\n  right: 0px;\n  bottom: 0px;\n  border: 1px solid #252525;\n  border-radius: 0.5em;\n  overflow: hidden;\n  background: linear-gradient(to bottom, rgba(82, 82, 82, 0.1) 0%, rgba(37, 37, 37, 0) 40%, rgba(0, 0, 0, 0.1) 100%);\n}\n.UkiButton img {\n  position: relative;\n  width: 1.5em;\n  height: 1.5em;\n  filter: url(#recolorImageTo252525);\n  margin: 0px 0.5em;\n}\n.UkiButton.small img {\n  width: 0.75em;\n  height: 0.75em;\n  margin: 0px 0.5em;\n}\n.UkiButton.tiny img {\n  width: 0.5em;\n  height: 0.5em;\n  margin: 0px 0.25em;\n}\n.UkiButton .label {\n  position: relative;\n  white-space: nowrap;\n  color: #252525;\n  margin-right: 0.5em;\n}\n.UkiButton .label.labelOnly {\n  margin-left: 0.5em;\n}\n.UkiButton.small .label {\n  font-size: 0.7em;\n  margin-right: 0.5em;\n}\n.UkiButton.small .label.labelOnly {\n  margin-left: 0.5em;\n}\n.UkiButton.tiny .label {\n  font-size: 0.5em;\n  margin-right: 0.25em;\n}\n.UkiButton.tiny .label.labelOnly {\n  margin-left: 0.25em;\n}\n.UkiButton .badge {\n  position: absolute;\n  font-size: 0.7em;\n  font-weight: 600;\n  font-family: 'Source Sans Pro', Arial, sans-serif;\n  right: -0.5em;\n  top: -0.5em;\n  text-align: center;\n  min-width: 0.65em;\n  padding: 0em 0.25em 0em 0.25em;\n  background-color: #252525;\n  color: #BDBDBD;\n  border-radius: 0.5em;\n  border: 1px solid #252525;\n}\n.UkiButton:hover a {\n  border-color: #252525;\n  background: linear-gradient(to bottom, rgba(82, 82, 82, 0.25) 0%, rgba(37, 37, 37, 0.25) 40%, rgba(0, 0, 0, 0.5) 100%);\n}\n.UkiButton:active a {\n  border-color: #252525;\n  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.5) 0%, rgba(37, 37, 37, 0.25) 40%, rgba(82, 82, 82, 0.5) 100%);\n}\n.UkiButton.selected a {\n  border-color: #252525;\n  background: linear-gradient(to bottom, #525252 0%, #252525 40%, #000000 100%);\n}\n.UkiButton.selected img {\n  filter: url(#recolorImageToF7F7F7);\n}\n.UkiButton.selected .label {\n  color: #F7F7F7;\n}\n.UkiButton.selected:hover a {\n  border-color: #252525;\n  background: linear-gradient(to bottom, #525252 0%, #252525 40%, black 100%);\n}\n.UkiButton.selected:active a {\n  border-color: #252525;\n  background: linear-gradient(to bottom, black 0%, #252525 40%, #525252 100%);\n}\n.UkiButton.disabled,\n.UkiButton.disabled:hover,\n.UkiButton.disabled:active {\n  cursor: default;\n}\n.UkiButton.disabled a,\n.UkiButton.disabled:hover a,\n.UkiButton.disabled:active a {\n  border-color: #D9D9D9;\n  background: #BDBDBD;\n}\n.UkiButton.disabled img,\n.UkiButton.disabled:hover img,\n.UkiButton.disabled:active img {\n  filter: url(#recolorImageToD9D9D9);\n}\n.UkiButton.disabled .label,\n.UkiButton.disabled:hover .label,\n.UkiButton.disabled:active .label {\n  color: #D9D9D9;\n}\n.UkiButton.disabled .badge,\n.UkiButton.disabled:hover .badge,\n.UkiButton.disabled:active .badge {\n  color: #D9D9D9;\n  border-color: #D9D9D9;\n  background-color: #BDBDBD;\n}\n";

/* globals d3 */

var recolorImageFilter = () => {
  // debounce; it's common for a bunch of things to call this on page load
  let timeout;
  window.clearTimeout(timeout);
  timeout = window.setTimeout(() => {
    // Extract all filters that look like url(#recolorImageToFFFFFF) from the
    // stylesheets that have been loaded in the document
    const colorScheme = {};
    for (const styleSheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(styleSheet.cssRules || styleSheet.rules)) {
          if (rule.style && rule.style.filter) {
            let hexCode = /#recolorImageTo(......)/.exec(rule.style.filter);
            if (hexCode && hexCode[1]) {
              colorScheme[hexCode[1]] = true;
            }
          }
        }
      } catch (err) {
        if (!(err instanceof window.DOMException)) {
          throw err;
        }
      }
    }

    for (const color of window.recolorImageFilterList || []) {
      colorScheme[color] = true;
    }

    if (d3.select('#recolorImageFilters').size() === 0) {
      let svg = d3.select('body').append('svg')
        .attr('id', 'recolorImageFilters')
        .attr('width', 0)
        .attr('height', 0);
      svg.append('defs');
    }

    // Generate SVG filters that can recolor images to whatever
    // color we need. Styles simply do something like
    // filter: url(#recolorImageToFFFFFF)
    let recolorFilters = d3.select('#recolorImageFilters')
      .selectAll('filter.recolor')
      .data(Object.keys(colorScheme), d => d);
    let recolorFiltersEnter = recolorFilters.enter().append('filter')
      .attr('class', 'recolor')
      .attr('id', d => 'recolorImageTo' + d);
    let cmpTransferEnter = recolorFiltersEnter.append('feComponentTransfer')
      .attr('in', 'SourceAlpha')
      .attr('result', 'color');
    cmpTransferEnter.append('feFuncR')
      .attr('type', 'linear')
      .attr('slope', 0)
      .attr('intercept', d => {
        let hexvalue = d.slice(0, 2);
        return Math.pow(parseInt(hexvalue, 16) / 255, 2);
      });
    cmpTransferEnter.append('feFuncG')
      .attr('type', 'linear')
      .attr('slope', 0)
      .attr('intercept', d => {
        let hexvalue = d.slice(2, 4);
        return Math.pow(parseInt(hexvalue, 16) / 255, 2);
      });
    cmpTransferEnter.append('feFuncB')
      .attr('type', 'linear')
      .attr('slope', 0)
      .attr('intercept', d => {
        let hexvalue = d.slice(4, 6);
        return Math.pow(parseInt(hexvalue, 16) / 255, 2);
      });
  }, 100);
};

const { UkiButton, UkiButtonMixin } = createMixinAndDefault({
  DefaultSuperClass: View,
  classDefFunc: SuperClass => {
    class UkiButton extends ThemeableMixin({
      SuperClass, defaultStyle: defaultStyle$6, className: 'UkiButton'
    }) {
      constructor (options) {
        super(options);

        this._size = options.size;
        this._label = options.label;
        this._img = options.img;
        this._disabled = options.disabled || false;
        this._selected = options.selected || false;
        this._badge = options.badge;
      }
      set size (value) {
        this._size = value;
        this.render();
      }
      get size () {
        return this._size;
      }
      set label (value) {
        this._label = value;
        this.render();
      }
      get label () {
        return this._label;
      }
      set img (value) {
        this._img = value;
        this.render();
      }
      get img () {
        return this._img;
      }
      set disabled (value) {
        this._disabled = value;
        this.render();
      }
      get disabled () {
        return this._disabled;
      }
      set selected (value) {
        this._selected = value;
        this.render();
      }
      get selected () {
        return this._selected;
      }
      set badge (value) {
        this._badge = value;
        this.render();
      }
      get badge () {
        return this._badge;
      }
      setup () {
        super.setup(...arguments);
        recolorImageFilter();
        this.d3el.append('a');
        this.d3el.append('img')
          .style('display', 'none');
        this.d3el.append('div')
          .classed('label', true)
          .style('display', 'none');
        this.d3el.append('div')
          .classed('badge', true)
          .style('display', 'none');

        this.d3el.on('click', () => {
          if (!this.disabled) {
            this.trigger('click');
          }
        });
      }
      draw () {
        super.draw(...arguments);

        this.d3el
          .classed('small', this.size === 'small')
          .classed('tiny', this.size === 'tiny')
          .classed('selected', this.selected)
          .classed('disabled', this.disabled);

        this.d3el.select('img')
          .style('display', this.img ? null : 'none')
          .attr('src', this.img);

        this.d3el.select('.label')
          .classed('labelOnly', !this.img)
          .style('display', this.label === undefined ? 'none' : null)
          .text(this.label);

        this.d3el.select('.badge')
          .style('display', this.badge === undefined ? 'none' : null)
          .text(this.badge);
      }
    }
    return UkiButton;
  }
});

var defaultStyle$7 = "/*\nCurrent color scheme\n\nUsing ColorBrewer schemes:\nhttp://colorbrewer2.org/#type=qualitative&scheme=Dark2&n=8\nhttp://colorbrewer2.org/#type=qualitative&scheme=Pastel2&n=8\n*/\n/*\nColor meanings:\n*/\n/*\nDummy class that exposes colors for assignment to classes in Javascript:\n*/\n.classColorList {\n  filter: url(#recolorImageTo1B9E77);\n  filter: url(#recolorImageToD95F02);\n  filter: url(#recolorImageTo7570B3);\n  filter: url(#recolorImageToE7298A);\n  filter: url(#recolorImageTo66A61E);\n  filter: url(#recolorImageToE6AB02);\n  filter: url(#recolorImageToA6761D);\n  filter: url(#recolorImageToB3E2CD);\n  filter: url(#recolorImageToFDCDAC);\n  filter: url(#recolorImageToCBD5E8);\n  filter: url(#recolorImageToF4CAE4);\n  filter: url(#recolorImageToE6F5C9);\n  filter: url(#recolorImageToFFF2AE);\n  filter: url(#recolorImageToF1E2CC);\n}\n/*\nGradients:\n*/\n.ModalView {\n  position: absolute;\n  left: 0px;\n  top: 0px;\n  right: 0px;\n  bottom: 0px;\n  display: flex;\n  background-color: rgba(37, 37, 37, 0.75);\n  z-index: 1000;\n}\n.ModalView .centerWrapper {\n  position: relative;\n  background-color: #F7F7F7;\n  border: 1px solid #252525;\n  box-shadow: 0.5em 0.5em 2em #252525;\n  min-width: 20em;\n  max-width: calc(100% - 4em);\n  min-height: 20em;\n  max-height: calc(100% - 4em);\n  margin: auto;\n  padding: 1em;\n}\n.ModalView .centerWrapper .contents {\n  margin-bottom: 3.5em;\n  max-height: calc(100vh - 7.5em);\n}\n.ModalView .buttonWrapper {\n  position: absolute;\n  bottom: 1em;\n  right: 1em;\n  display: flex;\n  justify-content: flex-end;\n  align-items: center;\n}\n.ModalView .buttonWrapper .UkiButton {\n  margin-left: 1em;\n}\n";

var template = "<div class=\"centerWrapper\">\n  <div class=\"contents\"></div>\n  <div class=\"buttonWrapper\"></div>\n</div>\n";

const { ModalView, ModalViewMixin } = createMixinAndDefault({
  DefaultSuperClass: View,
  classDefFunc: SuperClass => {
    class ModalView extends ThemeableMixin({
      SuperClass, defaultStyle: defaultStyle$7, className: 'ModalView'
    }) {
      get defaultButtons () {
        return [
          {
            label: 'Cancel',
            className: 'cancel',
            onclick: () => { this.hide(); }
          },
          {
            label: 'OK',
            className: 'ok',
            selected: true,
            onclick: () => { this.hide(); }
          }
        ];
      }
      show (options = {}) {
        this.contents.html(options.content || '');
        this.setupButtons(options.buttons || this.defaultButtons);
        this.d3el.style('display', options.hide ? 'none' : null);
      }
      hide () {
        this.show({ hide: true });
      }
      setup () {
        super.setup(...arguments);
        this.d3el
          .style('display', 'none')
          .html(template);

        this.contents = this.d3el.select('.contents')
          .classed(this.type, true);
        this.buttonWrapper = this.d3el.select('.buttonWrapper');

        this.setupButtons();
      }
      setupButtons (buttonSpecs = this.defaultButtons) {
        this.buttonWrapper.html('');
        for (const spec of buttonSpecs) {
          spec.d3el = this.buttonWrapper.append('div');
          const button = new UkiButton(spec);
          button.on('click', () => { spec.onclick.call(this); });
        }
      }
    }
    return ModalView;
  }
});

var defaultStyle$8 = "/*\nCurrent color scheme\n\nUsing ColorBrewer schemes:\nhttp://colorbrewer2.org/#type=qualitative&scheme=Dark2&n=8\nhttp://colorbrewer2.org/#type=qualitative&scheme=Pastel2&n=8\n*/\n/*\nColor meanings:\n*/\n/*\nDummy class that exposes colors for assignment to classes in Javascript:\n*/\n.classColorList {\n  filter: url(#recolorImageTo1B9E77);\n  filter: url(#recolorImageToD95F02);\n  filter: url(#recolorImageTo7570B3);\n  filter: url(#recolorImageToE7298A);\n  filter: url(#recolorImageTo66A61E);\n  filter: url(#recolorImageToE6AB02);\n  filter: url(#recolorImageToA6761D);\n  filter: url(#recolorImageToB3E2CD);\n  filter: url(#recolorImageToFDCDAC);\n  filter: url(#recolorImageToCBD5E8);\n  filter: url(#recolorImageToF4CAE4);\n  filter: url(#recolorImageToE6F5C9);\n  filter: url(#recolorImageToFFF2AE);\n  filter: url(#recolorImageToF1E2CC);\n}\n/*\nGradients:\n*/\n.tooltip {\n  position: fixed;\n  z-index: 1001;\n  padding: 0.5em;\n  border-radius: 0.5em;\n  background: #252525;\n  color: #F7F7F7;\n  box-shadow: 2px 2px 5px rgba(0, 0, 0, 0.25);\n  pointer-events: none;\n  max-height: 250px;\n  overflow-y: auto;\n}\n.tooltip.interactive {\n  pointer-events: all;\n}\n.tooltip .menuItem {\n  margin: 0.5em 0;\n}\n.tooltip .menuItem.submenu {\n  margin-right: 1em;\n}\n.tooltip .menuItem.submenu:after {\n  content: '\\25b6';\n  color: #F7F7F7;\n  position: absolute;\n  right: -1em;\n  top: 0.75em;\n}\n";

/* globals d3 */

const { TooltipView, TooltipViewMixin } = createMixinAndDefault({
  DefaultSuperClass: View,
  classDefFunc: SuperClass => {
    class TooltipView extends ThemeableMixin({
      SuperClass, defaultStyle: defaultStyle$8, className: 'tooltip'
    }) {
      setup () {
        super.setup(...arguments);
        this.hide();
      }
      draw () {
        super.draw(...arguments);
        // TODO: migrate a lot of the show() stuff here?
      }
      hide () {
        this.show({ content: null });
      }
      /**
         * @param  {String | Function} [content='']
         * The message that will be displayed; a falsey value hides the tooltip.
         * If, instead of a string, a function is supplied, that function will be
         * called with a d3-selected div as its first argument (useful for more
         * complex, custom tooltip contents)
         * @param  {Object} [targetBounds=null]
         * Specifies a target rectangle that the tooltip should be positioned
         * relative to; usually element.getBoundingClientRect() will do the trick,
         * but you could also specify a similarly-formatted custom rectangle
         * @param  {Object} [anchor=null]
         * Specifies -1 to 1 positioning of the tooltip relative to targetBounds;
         * for example, { x: -1 } would right-align the tooltip to the left edge of
         * targetBounds, { x: 0 } would center the tooltip horizontally, and
         * { x: 1 } would left-align the tooltip to the right edge of targetBounds
         * @param  {Boolean} [interactive = false]
         * Specifies whether pointer-events should register on the tooltip
         * element(s); if false, pointer events will pass through
         * @param  {Number} [nestNew = 0]
         * If true, adds an additional "tooltip"-classed element instead of
         * replacing the existing one (useful for things like nested context menus)
         */
      async show ({
        content = '',
        targetBounds = null,
        anchor = null,
        hideAfterMs = 1000,
        interactive = false,
        nestNew = 0
      } = {}) {
        window.clearTimeout(this._tooltipTimeout);
        const showEvent = d3.event;
        d3.select('body').on('click.tooltip', () => {
          if (showEvent === d3.event) {
            // This is the same event that opened the tooltip; absorb the event to
            // prevent flicker
            d3.event.stopPropagation();
          } else if (!interactive || !this.d3el.node().contains(d3.event.target)) {
            // Only hide the tooltip if we interacted with something outside an
            // interactive tooltip (otherwise don't mess with the event)
            this.hide();
          }
        });

        let tooltip = this.d3el;
        if (nestNew > 0) {
          this._nestedTooltips = this._nestedTooltips || [];
          // Remove any existing tooltips at or deeper than this layer
          while (this._nestedTooltips.length > nestNew) {
            this._nestedTooltips.splice(this._nestedTooltips.length - 1, 1)[0].remove();
          }
          tooltip = this.d3el.append('div')
            .classed('tooltip', true);
          this._nestedTooltips[nestNew] = tooltip;
        }

        tooltip
          .classed('interactive', interactive)
          .style('left', '-1000em')
          .style('top', '-1000em')
          .style('display', content ? null : 'none');

        if (!content) {
          d3.select('body').on('click.tooltip', null);
          this._nestedTooltips = [];
        } else {
          if (typeof content === 'function') {
            await content(tooltip);
          } else {
            tooltip.html(content);
          }
          let tooltipBounds = tooltip.node().getBoundingClientRect();

          let left;
          let top;

          if (targetBounds === null) {
            // todo: position the tooltip WITHIN the window, based on anchor,
            // instead of outside the targetBounds
            throw new Error('tooltips without targets are not yet supported');
          } else {
            anchor = anchor || {};
            if (anchor.x === undefined) {
              if (anchor.y !== undefined) {
                // with y defined, default is to center x
                anchor.x = 0;
              } else {
                if (targetBounds.left > window.innerWidth - targetBounds.right) {
                  // there's more space on the left; try to put it there
                  anchor.x = -1;
                } else {
                  // more space on the right; try to put it there
                  anchor.x = 1;
                }
              }
            }
            if (anchor.y === undefined) {
              if (anchor.x !== undefined) {
                // with x defined, default is to center y
                anchor.y = 0;
              } else {
                if (targetBounds.top > window.innerHeight - targetBounds.bottom) {
                  // more space above; try to put it there
                  anchor.y = -1;
                } else {
                  // more space below; try to put it there
                  anchor.y = 1;
                }
              }
            }
            left = (targetBounds.left + targetBounds.right) / 2 +
                   anchor.x * targetBounds.width / 2 -
                   tooltipBounds.width / 2 +
                   anchor.x * tooltipBounds.width / 2;
            top = (targetBounds.top + targetBounds.bottom) / 2 +
                  anchor.y * targetBounds.height / 2 -
                  tooltipBounds.height / 2 +
                  anchor.y * tooltipBounds.height / 2;
          }

          // Clamp the tooltip so that it stays on screen
          if (left + tooltipBounds.width > window.innerWidth) {
            left = window.innerWidth - tooltipBounds.width;
          }
          if (left < 0) {
            left = 0;
          }
          if (top + tooltipBounds.height > window.innerHeight) {
            top = window.innerHeight - tooltipBounds.height;
          }
          if (top < 0) {
            top = 0;
          }
          tooltip.style('left', left + 'px')
            .style('top', top + 'px');

          if (hideAfterMs > 0) {
            this._tooltipTimeout = window.setTimeout(() => {
              this.hide();
            }, hideAfterMs);
          }
        }
      }
      /**
         * @param  {Array} [menuEntries]
         * A list of objects for each menu item. Each object can have these
         * properties:
         * - A `content` property that is a string, a function, or an object. If a
         *   string or object are provided, a `UkiButton` will be created (the
         *   object will be passed to the `UkiButton` constructor, or the string
         *   will be the `UkiButton`'s `label`). A function will be given a div
         *   for custom formatting, and no `UkiButton` will be created. If
         *  `content` is not provided or is falsey, a separator is drawn.
         * - Either an `onClick` function that will be called when the menu entry is
         *   clicked, or a `subEntries` list of additional menuEntries
         * @param  {Object} [targetBounds=null]
         * Specifies a target rectangle that the tooltip should be positioned
         * relative to; usually element.getBoundingClientRect() will do the trick,
         * but you could also specify a similarly-formatted custom rectangle
         * @param  {Object} [anchor=null]
         * Specifies -1 to 1 positioning of the tooltip relative to targetBounds;
         * for example, { x: -1 } would right-align the tooltip to the left edge of
         * targetBounds, { x: 0 } would center the tooltip horizontally, and
         * { x: 1 } would left-align the tooltip to the right edge of targetBounds
         * @param  {Number} [nestLayer = 0]
         * This should be false for most use cases; it's used internally for nested
         * context menus
         */
      async showContextMenu ({ menuEntries, targetBounds, anchor, nestNew = 0 } = {}) {
        const self = this;
        await this.show({
          targetBounds,
          anchor,
          hideAfterMs: 0,
          interactive: true,
          nestNew,
          content: async d3el => {
            d3el.html('');

            const menuItems = d3el.selectAll('.menuItem')
              .data(menuEntries)
              .enter().append('div')
              .classed('menuItem', true)
              .classed('submenu', d => !!d.subEntries);
            const contentFuncPromises = [];
            menuItems.each(function (d) {
              let item;
              if (!d.content) {
                item = d3.select(this);
                item.append('hr');
              } else if (typeof d.content === 'function') {
                item = d3.select(this);
                contentFuncPromises.push(d.content(item));
              } else {
                const ukiProps = typeof d.content === 'object' ? d.content : { label: d.content };
                Object.assign(ukiProps, { d3el: d3.select(this) });
                item = new UkiButton(ukiProps);
                contentFuncPromises.push(item.render());
              }
              item.on('click', function () {
                if (d.onClick) {
                  d.onClick();
                  self.hide();
                } else if (d.subEntries) {
                  let targetBounds = this instanceof UkiButton
                    ? this.d3el.node().getBoundingClientRect()
                    : this.getBoundingClientRect();
                  targetBounds = {
                    left: targetBounds.left,
                    right: targetBounds.right + TooltipView.SUBMENU_OFFSET,
                    top: targetBounds.top,
                    bottom: targetBounds.bottom,
                    width: targetBounds.width + TooltipView.SUBMENU_OFFSET,
                    height: targetBounds.height
                  };
                  self.showContextMenu({
                    menuEntries: d.subEntries,
                    targetBounds,
                    anchor,
                    interactive: true,
                    nestNew: nestNew + 1
                  });
                }
              });
            });
            await Promise.all(contentFuncPromises);
          }
        });
      }
    }
    TooltipView.SUBMENU_OFFSET = 20;
    return TooltipView;
  }
});

const { AnimatedView, AnimatedViewMixin } = createMixinAndDefault({
  DefaultSuperClass: View,
  classDefFunc: SuperClass => {
    class AnimatedView extends SuperClass {
      constructor (options) {
        super(options);
        this.stop = false;
        this.framerate = options.framerate || 60;
        this.on('drawFinished.AnimatedViewMixin', () => {
          this.off('drawFinished.AnimatedViewMixin');
          this.startAnimationLoop();
        });
      }
      startAnimationLoop () {
        this.stop = false;
        const timestamp = () => {
          return window.performance && window.performance.now ? window.performance.now() : new Date().getTime();
        };

        let now;
        let dt = 0;
        let last = timestamp();
        let step = 1 / this.framerate;

        const frame = () => {
          if (this.stop) {
            return;
          }
          now = timestamp();
          dt = dt + Math.min(1, (now - last) / 1000);
          while (dt > step) {
            dt = dt - step;
            this.drawFrame(this.d3el, dt);
          }
          last = now;
          window.requestAnimationFrame(frame);
        };
        window.requestAnimationFrame(frame);
      }
      stopAnimationLoop () {
        this.stop = true;
      }
      drawFrame (d3el, timeSinceLastFrame) {}
    }
    return AnimatedView;
  }
});

var ui = /*#__PURE__*/Object.freeze({
  __proto__: null,
  LoadingView: LoadingView,
  LoadingViewMixin: LoadingViewMixin,
  EmptyStateView: EmptyStateView,
  EmptyStateViewMixin: EmptyStateViewMixin,
  ParentSizeView: ParentSizeView,
  ParentSizeViewMixin: ParentSizeViewMixin,
  SvgView: SvgView,
  SvgViewMixin: SvgViewMixin,
  IFrameView: IFrameView,
  IFrameViewMixin: IFrameViewMixin,
  UkiButton: UkiButton,
  UkiButtonMixin: UkiButtonMixin,
  ModalView: ModalView,
  ModalViewMixin: ModalViewMixin,
  TooltipView: TooltipView,
  TooltipViewMixin: TooltipViewMixin,
  AnimatedView: AnimatedView,
  AnimatedViewMixin: AnimatedViewMixin,
  ThemeableMixin: ThemeableMixin
});

var defaultStyle$9 = ".BaseTableView table {\n  border-collapse: collapse;\n  font-size: 10.5pt;\n}\n.BaseTableView th {\n  background-color: #ccc;\n}\n.BaseTableView th,\n.BaseTableView td {\n  border: 1px solid #ccc;\n  text-align: left;\n  vertical-align: bottom;\n  padding: 2px;\n}\n.BaseTableView th > div,\n.BaseTableView td > div {\n  max-height: 4em;\n  max-width: 5em;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.BaseTableView th {\n  position: sticky;\n  top: -1px;\n}\n";

var template$1 = "<table>\n  <thead>\n    <tr></tr>\n  </thead>\n  <tbody>\n  </tbody>\n</table>\n";

/* globals d3 */

const { BaseTableView, BaseTableViewMixin } = createMixinAndDefault({
  DefaultSuperClass: View,
  classDefFunc: SuperClass => {
    class BaseTableView extends ThemeableMixin({
      SuperClass, defaultStyle: defaultStyle$9, className: 'BaseTableView'
    }) {
      constructor (options) {
        super(options);
        // By default, keep the original order
        this._rowSortFunc = options.rowSortFunc || null;
        this._rowIndexMode = options.rowIndexMode || 'none';
      }
      get rowIndexMode () {
        return this._rowIndexMode;
      }
      set rowIndexMode (value) {
        this._rowIndexMode = value;
        this.render();
      }
      get rowSortFunc () {
        return this._rowSortFunc;
      }
      set rowSortFunc (func) {
        this._rowSortFunc = func;
        this.render();
      }
      getRawHeaders () {
        const rawRows = this.getRawRows();
        if (rawRows.length === 0) {
          return [];
        } else {
          return Object.keys(rawRows[0]);
        }
      }
      getHeaders () {
        let headers = this.getRawHeaders().map((data, index) => {
          return { index, data };
        });
        if (this.rowIndexMode === 'rowIndex') {
          headers.unshift({ index: 'rowIndex' });
        } else if (this.rowIndexMode === 'itemIndex') {
          headers.unshift({ index: 'itemIndex' });
        }
        return headers;
      }
      getRawRows () {
        throw new Error(`getRows() not implemented by subclass`);
      }
      getRows () {
        let rows = this.getRawRows().map((data, itemIndex) => {
          return { itemIndex, rowIndex: itemIndex, data };
        });
        if (this.rowSortFunc) {
          rows.sort(this.rowSortFunc);
          rows.forEach((row, rowIndex) => {
            row.rowIndex = rowIndex;
          });
        }
        return rows;
      }
      setup () {
        super.setup(...arguments);

        this.d3el.html(template$1);
      }
      async showTooltip (tooltipArgs) {
        // Can + should be overridden if there's a global Tooltip instance somewhere
        if (!window.uki) {
          window.uki = {};
        }
        if (!window.uki.tooltip) {
          window.uki.tooltip = new TooltipView({
            d3el: d3.select('body').append('div')
          });
          await window.uki.tooltip.render();
        }
        window.uki.tooltip.show(tooltipArgs);
      }
      draw () {
        super.draw(...arguments);

        if (this.isHidden || this.isLoading || this.emptyMessage) {
          return;
        }
        this.drawHeaders();
        this.drawRows();
        this.drawCells();
      }
      drawHeaders () {
        const headersToDraw = this.getHeaders();

        this.headers = this.d3el.select('thead tr')
          .selectAll('th').data(headersToDraw, d => d.index)
          .order();
        this.headers.exit().remove();
        const headersEnter = this.headers.enter().append('th');
        this.headers = this.headers.merge(headersEnter);

        headersEnter.append('div')
          .filter(d => d.index === 'rowIndex' || d.index === 'itemIndex')
          .classed('corner', true);
        this.cornerHeader = this.headers.select('.corner');
        if (!this.cornerHeader.node()) {
          this.cornerHeader = null;
        }
        const self = this;
        this.headers.select('div')
          .each(function (d) {
            const d3el = d3.select(this);
            self.updateHeader(d3el, d);
            self.updateHoverListeners(d3el, d);
          });
      }
      updateHeader (d3el, header) {
        d3el.text(header.data);
      }
      drawRows () {
        this.rows = this.d3el.select('tbody')
          .selectAll('tr').data(this.getRows(), d => d.itemIndex)
          .order();
        this.rows.exit().remove();
        const rowsEnter = this.rows.enter().append('tr');
        this.rows = this.rows.merge(rowsEnter);
      }
      drawCells () {
        this.cells = this.rows.selectAll('td')
          .data(row => this.getHeaders().map((header, columnIndex) => {
            return {
              headerData: header.data,
              headerIndex: header.index,
              columnIndex: columnIndex,
              itemIndex: row.itemIndex,
              rowIndex: row.rowIndex,
              data: header.index === 'rowIndex' ? row.rowIndex
                : header.index === 'itemIndex' ? row.itemIndex
                  : row.data[header.data]
            };
          }));
        this.cells.exit().remove();
        const cellsEnter = this.cells.enter().append('td');
        this.cells = this.cells.merge(cellsEnter);

        cellsEnter.append('div'); // wrapper needed for flexible styling, like limiting height
        const self = this;
        this.cells.select('div')
          .each(function (d) {
            const d3el = d3.select(this);
            self.updateCell(d3el, d);
            self.updateHoverListeners(d3el, d);
          });
      }
      updateCell (d3el, cell) {
        d3el.text(cell.data);
      }
      updateHoverListeners (d3el, item) {
        // Show a tooltip on the parent td or th element if the contents are
        // truncated by text-overflow: ellipsis
        const element = d3el.node();
        if (element.clientHeight < element.scrollHeight) {
          d3el.on('mouseenter.baseTableView', () => {
            this.showTooltip({
              content: item.data === undefined || item.data === null ? null : item.data,
              targetBounds: element.getBoundingClientRect()
            });
          }).on('mouseleave.baseTableView', () => {
            this.showTooltip({ content: null });
          });
        } else {
          d3el.on('mouseenter.baseTableView', null)
            .on('mouseleave.baseTableView', null);
        }
      }
    }
    return BaseTableView;
  }
});

var gearIcon = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>\n<svg\n   xmlns:dc=\"http://purl.org/dc/elements/1.1/\"\n   xmlns:cc=\"http://creativecommons.org/ns#\"\n   xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"\n   xmlns:svg=\"http://www.w3.org/2000/svg\"\n   xmlns=\"http://www.w3.org/2000/svg\"\n   xmlns:sodipodi=\"http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd\"\n   xmlns:inkscape=\"http://www.inkscape.org/namespaces/inkscape\"\n   sodipodi:docname=\"gear.svg\"\n   inkscape:version=\"1.0 (4035a4fb49, 2020-05-01)\"\n   id=\"svg8\"\n   version=\"1.1\"\n   viewBox=\"0 0 511.41864 512\"\n   height=\"512\"\n   width=\"511.41864\">\n  <defs\n     id=\"defs2\" />\n  <sodipodi:namedview\n     fit-margin-bottom=\"0\"\n     fit-margin-right=\"0\"\n     fit-margin-left=\"0\"\n     fit-margin-top=\"0\"\n     inkscape:document-rotation=\"0\"\n     inkscape:pagecheckerboard=\"false\"\n     inkscape:window-maximized=\"1\"\n     inkscape:window-y=\"-12\"\n     inkscape:window-x=\"-12\"\n     inkscape:window-height=\"1890\"\n     inkscape:window-width=\"3000\"\n     units=\"px\"\n     showgrid=\"true\"\n     inkscape:current-layer=\"layer1\"\n     inkscape:document-units=\"px\"\n     inkscape:cy=\"405.52354\"\n     inkscape:cx=\"165.62285\"\n     inkscape:zoom=\"0.7\"\n     inkscape:pageshadow=\"2\"\n     inkscape:pageopacity=\"0.0\"\n     borderopacity=\"1.0\"\n     bordercolor=\"#666666\"\n     pagecolor=\"#ffffff\"\n     id=\"base\">\n    <inkscape:grid\n       originy=\"-479.8705\"\n       originx=\"-106.04959\"\n       spacingy=\"20\"\n       spacingx=\"20\"\n       id=\"grid1358\"\n       type=\"xygrid\" />\n  </sodipodi:namedview>\n  <metadata\n     id=\"metadata5\">\n    <rdf:RDF>\n      <cc:Work\n         rdf:about=\"\">\n        <dc:format>image/svg+xml</dc:format>\n        <dc:type\n           rdf:resource=\"http://purl.org/dc/dcmitype/StillImage\" />\n        <dc:title></dc:title>\n      </cc:Work>\n    </rdf:RDF>\n  </metadata>\n  <g\n     transform=\"translate(-106.04959,-491.12051)\"\n     id=\"layer1\"\n     inkscape:groupmode=\"layer\"\n     inkscape:label=\"Layer 1\">\n    <path\n       id=\"path859\"\n       d=\"m 329.33072,1000.8335 c -6.98056,-3.12316 -16.17441,-13.40405 -17.44655,-19.50953 -0.48794,-2.34175 -1.23015,-12.19351 -1.64933,-21.89283 -0.85788,-19.84951 -3.8765,-26.99802 -14.46418,-34.25271 -8.38236,-5.74376 -21.68441,-7.29075 -29.21063,-3.39692 -3.14227,1.62556 -9.90171,7.0274 -15.02097,12.00384 -13.32301,12.95164 -20.48928,16.81236 -31.22345,16.82078 -14.17987,0.0196 -18.77379,-2.68564 -39.37481,-23.11652 -15.78953,-15.65902 -19.6681,-20.69914 -22.03329,-28.63181 -4.26917,-14.31834 -1.41503,-22.2179 13.93077,-38.55724 6.9483,-7.39813 13.50063,-15.73269 14.56078,-18.521 5.0312,-13.233 0.20316,-27.60603 -12.41723,-36.96558 -4.49991,-3.33715 -9.41639,-4.30473 -26.45269,-5.20628 -17.40832,-0.92114 -22.07977,-1.86776 -27.79283,-5.63208 -14.07512,-9.27411 -14.68672,-11.20437 -14.68672,-46.35332 0,-35.53419 0.85904,-38.60859 13.17205,-47.14164 6.84329,-4.74228 9.97818,-5.43828 28.9536,-6.42702 17.399,-0.90664 22.28732,-1.85639 26.80659,-5.20804 12.62039,-9.35955 17.44843,-23.73237 12.41723,-36.96538 -1.06013,-2.78851 -7.63842,-11.1505 -14.61843,-18.58234 -6.98,-7.43203 -13.24031,-16.00956 -13.9118,-19.06122 -0.67151,-3.05185 -1.54926,-6.62159 -1.9506,-7.93306 -0.40134,-1.31166 0.52862,-6.6218 2.06658,-11.80076 2.2563,-7.59776 6.11819,-12.67225 19.99808,-26.27724 21.69485,-21.26519 28.01536,-25.16265 40.82154,-25.17212 11.25431,-0.008 22.43719,6.05021 34.18428,18.51999 12.92373,13.71878 25.87742,16.43207 40.02191,8.38301 11.84254,-6.73913 16.80239,-17.88429 16.80239,-37.75624 0,-19.39387 3.17036,-28.03709 13.04883,-35.5743 l 7.21554,-5.50543 h 31.84873 c 29.24484,0 32.30134,0.33513 37.38468,4.09909 11.23648,8.32001 14.35353,15.51416 14.35353,33.12799 0,18.50805 2.35876,27.12065 9.57403,34.95796 6.85223,7.44292 14.26484,11.09194 22.53217,11.09194 10.54201,0 16.27037,-3.01609 29.32404,-15.4397 14.79368,-14.07963 18.20385,-15.91163 29.61871,-15.91163 13.83084,0 20.06425,3.80754 40.51878,24.74992 28.46179,29.14062 29.98342,40.58709 8.44409,63.52099 -18.70942,19.92084 -21.85956,28.67609 -15.65788,43.51879 3.20779,7.67736 12.8525,16.66833 19.32742,18.01742 2.34177,0.48791 12.2495,1.19233 22.01718,1.56521 14.38919,0.54924 18.89535,1.48684 23.74482,4.94 12.54543,8.93297 13.36056,11.82964 13.36056,47.47141 0,30.2795 -0.27647,32.71862 -4.35802,38.44064 -7.84803,11.00216 -13.25711,13.14835 -36.16203,14.34833 -16.95876,0.88822 -21.9503,1.86187 -26.33161,5.13613 -8.32298,6.21971 -12.68897,13.15601 -13.88263,22.05547 -1.51419,11.28903 2.04642,18.96285 15.16747,32.68828 14.02411,14.67008 15.60067,17.7813 15.60067,30.78643 0,12.8176 -1.4131,15.04923 -24.27885,38.34327 -14.27908,14.54643 -19.67271,18.72733 -26.96415,20.90135 -14.99475,4.4707 -26.16574,0.40816 -41.83129,-15.21285 -4.3108,-4.29866 -10.4831,-9.44106 -13.71621,-11.42776 -10.42635,-6.40703 -24.53884,-4.06235 -34.94089,5.80509 -8.48494,8.04888 -11.10638,16.4481 -11.10638,35.58495 0,14.51391 -0.66808,18.08776 -4.40878,23.58405 -9.27289,13.62442 -12.25222,14.62382 -45.20362,15.15972 -21.78684,0.3545 -31.3445,-0.2314 -35.7212,-2.1895 z m 66.14183,-151.70734 c 25.94628,-8.67864 50.90012,-29.62427 61.67158,-51.76537 10.87443,-22.35253 11.4053,-24.70466 11.4053,-50.53089 0,-20.84512 -0.66708,-26.21011 -4.47857,-36.02014 -12.48715,-32.13944 -36.29306,-55.1909 -68.59831,-66.42428 -13.92116,-4.84065 -45.64323,-5.67714 -60.1663,-1.58657 -36.79417,10.36377 -66.89093,40.72832 -76.63263,77.31436 -3.17209,11.91331 -3.54206,40.13831 -0.67125,51.20984 10.92692,42.14031 44.25552,73.17324 88.0809,82.01393 9.57758,1.93202 38.36085,-0.522 49.38928,-4.21088 z\"\n       style=\"fill:#000000;stroke-width:1\" />\n  </g>\n</svg>\n";

/* globals d3 */

const { FlexTableView, FlexTableViewMixin } = createMixinAndDefault({
  DefaultSuperClass: BaseTableView,
  classDefFunc: SuperClass => {
    class FlexTableView extends SuperClass {
      constructor (options) {
        // FlexTable uses the corner header for its menu; showing either
        // itemIndex or rowIndex is recommended, so itemIndex is enabled by
        // default
        options.rowIndexMode = options.rowIndexMode || 'itemIndex';
        super(options);

        // By default, show all headers in their original order
        this.visibleHeaderIndices = null;
      }
      getHeaders () {
        const headers = super.getHeaders();
        if (this.visibleHeaderIndices === null) {
          return headers;
        } else {
          return this.visibleHeaderIndices.map(headerIndex => {
            return headers.find(h => h.index === headerIndex);
          });
        }
      }
      drawFlexMenu (tooltipEl) {
        const fullHeaderList = super.getHeaders();
        if (this.rowIndexMode !== 'none') {
          fullHeaderList.splice(0, 1);
        }

        tooltipEl.html(`<h3>Show columns:</h3><ul style="padding:0"></ul>`);

        let listItems = tooltipEl.select('ul')
          .selectAll('li').data(fullHeaderList);
        listItems.exit().remove();
        const listItemsEnter = listItems.enter().append('li');
        listItems = listItems.merge(listItemsEnter);

        listItems
          .style('max-width', '15em')
          .style('list-style', 'none')
          .on('click', () => {
            d3.event.stopPropagation();
          });

        listItemsEnter.append('input')
          .attr('type', 'checkbox')
          .attr('id', (d, i) => `attrCheckbox${i}`)
          .property('checked', d => this.headerIsVisible(d.index))
          .on('change', d => {
            this.toggleHeader(d);
          });
        listItemsEnter.append('label')
          .attr('for', (d, i) => `attrCheckbox${i}`)
          .text(d => d.data);
      }
      headerIsVisible (headerIndex) {
        return this.visibleHeaderIndices === null ||
          this.visibleHeaderIndices.indexOf(headerIndex) !== -1;
      }
      updateHeader (d3el, header) {
        if (d3el.node() === this.cornerHeader.node()) {
          if (!this.attributeSelector) {
            this.attributeSelector = new UkiButton({
              d3el: this.cornerHeader.append('div').classed('attributeSelector', true),
              img: URL.createObjectURL(new window.Blob([gearIcon], { type: 'image/svg+xml' })),
              size: 'small'
            });
          }
          this.attributeSelector.on('click', () => {
            this.showTooltip({
              content: tooltipEl => { this.drawFlexMenu(tooltipEl); },
              targetBounds: this.attributeSelector.d3el.node().getBoundingClientRect(),
              interactive: true,
              hideAfterMs: 0
            });
          });
        } else {
          super.updateHeader(d3el, header);
        }
      }
      toggleHeader (header) {
        if (this.visibleHeaderIndices === null) {
          // Show all but the header toggled
          this.visibleHeaderIndices = this.getHeaders().map(h2 => h2.index);
        }
        const index = this.visibleHeaderIndices.indexOf(header.index);
        if (index === -1) {
          this.visibleHeaderIndices.push(header.index);
        } else {
          this.visibleHeaderIndices.splice(index, 1);
        }
        this.render();
      }
    }
    return FlexTableView;
  }
});

var table = /*#__PURE__*/Object.freeze({
  __proto__: null,
  BaseTableView: BaseTableView,
  BaseTableViewMixin: BaseTableViewMixin,
  FlexTableView: FlexTableView,
  FlexTableViewMixin: FlexTableViewMixin
});

var utils = /*#__PURE__*/Object.freeze({
  __proto__: null,
  createMixinAndDefault: createMixinAndDefault,
  Introspectable: Introspectable,
  IntrospectableMixin: IntrospectableMixin,
  recolorImageFilter: recolorImageFilter
});

export { Model, View, goldenlayout, google, table, ui, utils as util };
