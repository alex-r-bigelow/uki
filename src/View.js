import Model from './Model.js';

/**
 * View classes
 */
class View extends Model {
  constructor (options = {}) {
    super(options);
    this.d3el = this.checkForEmptySelection(options.d3el || null);
    this.dirty = true;
    this._pauseRender = false;
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

  get pauseRender () {
    return this._pauseRender;
  }

  set pauseRender (value) {
    this._pauseRender = value;
    if (!this._pauseRender) {
      // Automatically start another render call if we unpause
      this.render();
    }
  }

  async render (d3el = this.d3el) {
    d3el = this.checkForEmptySelection(d3el);
    if (!this.d3el || (d3el && d3el.node() !== this.d3el.node())) {
      this.d3el = d3el;
      this.dirty = true;
    }

    await this.ready;
    if (!this.d3el || this._pauseRender) {
      // Don't execute any render calls until all resources are loaded,
      // we've actually been given a d3 element to work with, and we're not
      // paused
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
        if (this._pauseRender) {
          // Do a _pauseRender check immediately before we do a draw call;
          // resolve for this Promise has already been added to _renderResolves
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
}

export default View;
