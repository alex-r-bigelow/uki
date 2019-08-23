Developing
==========

# Other magic I'm considering adding:
- GoldenLayout integrations?
- Svg mixin that auto-updates its bounds based on CSS rules?
- Introspectable?
- CSS hacks for re-coloring icons?
- Making LESS variables accessible under `this.resources`?
- Promise-ifying `.trigger()` calls so that you can know when everyone has
  finished responding to an event?

# Documentation TODOs:
- implement a full force-directed example
- create / generate API jsdocs

# Releasing a new version
A list of reminders to make sure I don't forget any steps:

- Update the version in package.json
- `npm run build`
- Run each example (TODO: automated testing?)
- `git commit -a -m "commit message"`
- `git tag -a #.#.# -m "tag annotation"`
- `git push --tags`
- `npm publish`
- (maybe optional) Edit / document the release on Github