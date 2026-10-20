// Static images are webpack asset/resources — tell TS what the import
// yields (the emitted, content-hashed URL).
declare module '*.png' {
  const url: string;
  export default url;
}
