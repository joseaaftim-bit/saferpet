-- Marca de versão das imagens, para o navegador cachear a foto e só
-- rebuscar quando ela muda. Guardada em coluna própria para as listagens
-- não precisarem carregar a base64 inteira só para calcular um hash.

ALTER TABLE produtos ADD COLUMN IF NOT EXISTS foto_versao VARCHAR(16);
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS logo_versao VARCHAR(16);

-- Quem já tem imagem ganha uma versão inicial (o valor em si não importa,
-- só precisa mudar quando a imagem mudar).
UPDATE produtos SET foto_versao = 'v1' WHERE foto IS NOT NULL AND foto_versao IS NULL;
UPDATE empresas SET logo_versao = 'v1' WHERE logo IS NOT NULL AND logo_versao IS NULL;
