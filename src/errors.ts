/** 0 ok · 2 uso · 3 config/arquivo · 4 credencial · 5 gate de produção · 6 resolução · 7 servidor */
export type CodigoSaida = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export class ErroFluigctl extends Error {
  constructor(
    message: string,
    readonly codigo: CodigoSaida,
  ) {
    super(message);
    this.name = 'ErroFluigctl';
  }
}
