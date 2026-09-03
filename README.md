# X Grok Visible Translator

Translates only posts that enter the viewport and are not already in X's active interface language. The target language follows X's interface locale.

When X provides its native translation control, the script keeps and clicks that control. If X does not provide it, the script uses X's Grok translation endpoint to replace the post text in place. Each post translated by the script can be toggled back to its original text in the same position.

## Installation

Install the [userscript](https://raw.githubusercontent.com/llpgf/x-grok-visible-translate/main/x-grok-visible-translate.user.js) with a userscript manager extension.

## Notes

This script relies on an undocumented X endpoint. It may stop working when X changes its frontend, changes account eligibility, or rate-limits requests.

## License

MIT
