// @toast-ui/editor の型は package.json の exports から解決できないため、型ファイルを直接参照する
declare module "@toast-ui/editor" {
  import Editor from "@toast-ui/editor/types/index";
  export default Editor;
}
declare module "@toast-ui/editor/dist/i18n/ja-jp";
