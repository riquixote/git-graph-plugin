import { Plugin, FileSystemAdapter, normalizePath } from 'obsidian';
import * as child_process from 'child_process';
import * as util from 'util';

const execPromise = util.promisify(child_process.exec);

interface GitFile {
  path: string;
  name: string;
  added: number;
  deleted: number;
  isSpecial?: boolean;
  isRenamed?: boolean;
}

interface GitActivityData {
  total: number;
  files: GitFile[];
}

type GitActivities = Record<string, GitActivityData>;

export default class GitGraphPlugin extends Plugin {
  private gitCache = new Map<string, { timestamp: number, promise: Promise<GitActivities> }>();
  private readonly CACHE_TTL = 1000 * 60 * 5; 

  async onload() {
    this.registerMarkdownCodeBlockProcessor('gitGraph', (source, el, _ctx) => {
      const container = el.createEl('div', { cls: 'git-graph-wrapper' });
      
      const loadingContainer = container.createEl('div', { 
        attr: { 
            style: 'display: flex; justify-content: center; align-items: center; padding: 40px 20px; margin: 10px 0; border-radius: 10px; background: rgba(0,0,0,0.1); color: var(--text-muted, #a3abcb); font-size: 13px; font-family: monospace; letter-spacing: 0.5px;' 
        } 
      });
      loadingContainer.innerHTML = `<span style="margin-right: 8px; font-size: 16px;">⏳</span> Carregando histórico do Git...`;

      try {
        const folders = this.parseFolders(source);
        
        this.getGitDataFromMemory(folders).then((gitData) => {
          loadingContainer.remove(); 
          this.renderHeatmap(container, gitData);
        }).catch((error: unknown) => {
          loadingContainer.remove();
          const errorMessage = error instanceof Error ? error.message : String(error);
          container.createEl('div', { 
            text: `⚠️ Erro ao ler o repositório Git: ${errorMessage}`, 
            attr: { style: 'color: #ff657a; font-size: 12px; padding: 10px; font-family: monospace;' } 
          });
        });

      } catch (error: unknown) {
        loadingContainer.remove();
        const errorMessage = error instanceof Error ? error.message : String(error);
        container.createEl('div', { 
          text: `⚠️ Erro de parâmetro: ${errorMessage}`, 
          attr: { style: 'color: #ff657a; font-size: 12px; padding: 10px; font-family: monospace;' } 
        });
      }
    });
  }

  onunload() {
    this.gitCache.clear();
  }

  parseFolders(source: string): string[] {
    const match = source.match(/pastas:\s*(.+)/i);
    if (!match || !match[1]) return ['.'];
    
    const val = match[1].trim();
    if (val === '"."' || val === '.') return ['.'];

    const folderRegex = /"([^"]+)"/g;
    const folders: string[] = [];
    let result: RegExpExecArray | null;
    
    while ((result = folderRegex.exec(val)) !== null) {
      if (result[1]) folders.push(result[1]);
    }
    
    return folders.length > 0 ? folders : ['.'];
  }

  getStartDate(): Date {
    const hoje = new Date();
    const dataInicio = new Date();
    dataInicio.setDate(hoje.getDate() - 364);
    dataInicio.setDate(dataInicio.getDate() - dataInicio.getDay());
    return dataInicio;
  }

  getGitDataFromMemory(folders: string[]): Promise<GitActivities> {
    const cacheKey = folders.join('|');
    const cachedEntry = this.gitCache.get(cacheKey);

    if (cachedEntry && (Date.now() - cachedEntry.timestamp < this.CACHE_TTL)) {
      return cachedEntry.promise;
    }

    const fetchPromise = this._fetchGitData(folders);
    this.gitCache.set(cacheKey, { timestamp: Date.now(), promise: fetchPromise });

    return fetchPromise;
  }

  private async _fetchGitData(folders: string[]): Promise<GitActivities> {
    const adapter = this.app.vault.adapter;
    let vaultPath = null;

    if (adapter instanceof FileSystemAdapter) {
      vaultPath = adapter.getBasePath();
    }
    
    if (!vaultPath) throw new Error("Acesso ao sistema de arquivos não suportado (ex: Mobile).");

    const folderPaths = folders.map(f => `"${f}"`).join(' ');
    
    const dataInicio = this.getStartDate();
    const sinceDate = `${dataInicio.getFullYear()}-${String(dataInicio.getMonth() + 1).padStart(2, '0')}-${String(dataInicio.getDate()).padStart(2, '0')}`;
    
    const cmd = `git -c core.quotepath=false --no-pager log --no-merges --numstat --date=short --format="COMMIT_DATE:%ad" --since="${sinceDate}" -- ${folderPaths}`;

    const { stdout } = await execPromise(cmd, { cwd: vaultPath, maxBuffer: 10 * 1024 * 1024 });

    const atividades: GitActivities = {};
    const lines = stdout.split('\n');
    let currentDate = '';

    for (const line of lines) {
      const cleanLine = line.trim();
      if (!cleanLine) continue;

      if (cleanLine.startsWith('COMMIT_DATE:')) {
        currentDate = cleanLine.replace('COMMIT_DATE:', '').trim();
        if (!atividades[currentDate]) {
          atividades[currentDate] = { total: 0, files: [] };
        }
      } else {
        const parts = cleanLine.split(/\s+/);
        
        if (parts.length >= 3 && currentDate) {
          const addedStr = parts[0];
          const deletedStr = parts[1];
          
          const isSpecial = addedStr === '-' || deletedStr === '-' || (addedStr === '0' && deletedStr === '0');
          const added = isSpecial ? 0 : Number(addedStr) || 0;
          const deleted = isSpecial ? 0 : Number(deletedStr) || 0;
          
          let rawPath = parts.slice(2).join(' ');
          let isRenamed = false;
          
          if (rawPath.includes('=>')) {
              isRenamed = true;
              if (rawPath.includes('{')) {
                  rawPath = rawPath.replace(/\{.*?=>\s*(.*?)\}/g, '$1'); 
              } else {
                  rawPath = rawPath.split('=>').pop()?.trim() || rawPath;
              }
          }

          let filePath = rawPath.replace(/(^"|"$)/g, '').trim();

          if (filePath.includes('\\')) {
              try {
                  const byteStr = filePath.replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
                  filePath = decodeURIComponent(escape(byteStr));
              } catch (e) {}
          }

          const fileName = filePath.split('/').pop()?.replace(/\.md$/i, '') || 'Arquivo';
          
          const dataDia = atividades[currentDate];
          if (dataDia) {
            const somaModificacoes = (added + deleted);
            const pesoHeatmap = somaModificacoes > 0 ? somaModificacoes : 1;
            
            dataDia.total += pesoHeatmap;
            
            const arquivoExistente = dataDia.files.find(f => f.path === filePath);
            if (arquivoExistente) {
              arquivoExistente.added += added;
              arquivoExistente.deleted += deleted;
              if (isRenamed) arquivoExistente.isRenamed = true;
              if (somaModificacoes > 0) arquivoExistente.isSpecial = false; 
            } else {
              dataDia.files.push({ path: filePath, name: fileName, added, deleted, isSpecial, isRenamed });
            }
          }
        }
      }
    }

    return atividades;
  }

  renderHeatmap(container: HTMLElement, atividades: GitActivities) {
    const isDark = document.body.classList.contains("theme-dark");
    const coresTema = isDark 
      ? ["#2a2a37", "#1a4628", "#277038", "#3db551", "#57f273"]
      : ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"];

    const hoje = new Date();
    const dataInicio = this.getStartDate();

    const diasRender: Date[] = [];
    let atual = new Date(dataInicio);
    while (atual <= hoje) {
      diasRender.push(new Date(atual));
      atual.setDate(atual.getDate() + 1);
    }

    const totalSemanas = Math.ceil(diasRender.length / 7);

    const pluginBox = document.createElement('div');
    pluginBox.style.cssText = 'display: flex; flex-direction: column; padding: 16px; background: transparent; width: 100%; margin: 10px 0; font-family: monospace; overflow-x: auto; overflow-y: hidden;';

    pluginBox.createEl('div', {
        text: 'Contribuições do Último Ano',
        attr: { style: 'text-align: center; font-weight: bold; font-size: 14px; color: var(--text-normal, #e5e5e5); margin-bottom: 16px; letter-spacing: 0.5px;' }
    });

    const scrollWrapper = pluginBox.createEl('div', {
        attr: { style: 'display: flex; flex-direction: column; width: 100%; min-width: 650px;' }
    });

    const headerRow = scrollWrapper.createEl('div', { attr: { style: 'display: flex; gap: 10px; width: 100%; margin-bottom: 6px;' } });
    headerRow.createEl('div', { attr: { style: 'width: 28px; flex-shrink: 0;' } }); 

    const monthsGrid = headerRow.createEl('div', { attr: { style: `display: grid; grid-template-columns: repeat(${totalSemanas}, 1fr); gap: 3px; flex-grow: 1;` } });

    let currentMonth = -1;
    for (let i = 0; i < totalSemanas; i++) {
        const diaDaSemana = diasRender[i * 7];
        const colWrapper = monthsGrid.createEl('div', { attr: { style: 'position: relative; width: 100%; height: 14px;' } });
        
        if (diaDaSemana) {
            const month = diaDaSemana.getMonth();
            if (month !== currentMonth) {
                const monthName = diaDaSemana.toLocaleString('pt-BR', { month: 'short' });
                const formattedName = monthName.charAt(0).toUpperCase() + monthName.slice(1).replace('.', '');
                colWrapper.createEl('span', { text: formattedName, attr: { style: 'position: absolute; left: 0; bottom: 0; font-size: 10px; color: #a3abcb; font-family: monospace; white-space: nowrap;' } });
                currentMonth = month;
            }
        }
    }

    const gridLayoutDoc = scrollWrapper.createEl('div', { attr: { style: 'display: flex; gap: 10px; align-items: stretch; width: 100%;' } });

    const labelColuna = gridLayoutDoc.createEl('div', { attr: { style: 'display: grid; grid-template-rows: repeat(7, 1fr); gap: 3px; font-size: 9px; color: #a3abcb; text-align: right; width: 28px; align-items: center;' } });
    ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].forEach(dia => labelColuna.createEl('div', { text: dia }));

    const grid = gridLayoutDoc.createEl('div', { attr: { style: `display: grid; grid-template-rows: repeat(7, 1fr); grid-template-columns: repeat(${totalSemanas}, 1fr); grid-auto-flow: column; gap: 3px; flex: 1;` } });

    const detailsContainer = pluginBox.createEl('div', { attr: { style: 'margin-top: 12px; padding-top: 12px; display: flex; flex-direction: column; gap: 6px;' } });

    let totalAnualDeContribuicoes = 0;

    diasRender.forEach((dia) => {
      const dataStr = `${dia.getFullYear()}-${String(dia.getMonth() + 1).padStart(2, '0')}-${String(dia.getDate()).padStart(2, '0')}`;
      const diaData = atividades[dataStr];
      const contagem = diaData ? diaData.total : 0;
      
      totalAnualDeContribuicoes += contagem;
      
      let nivel = 0;
      if (contagem > 0 && contagem <= 10) nivel = 1;
      else if (contagem > 10 && contagem <= 50) nivel = 2;
      else if (contagem > 50 && contagem <= 150) nivel = 3;
      else if (contagem > 150) nivel = 4;

      const corHex = coresTema[nivel];

      const cell = grid.createEl('div', {
        attr: { 
          style: `width: 100%; aspect-ratio: 1; background-color: ${corHex}; border-radius: 2px; cursor: pointer; transition: transform 0.2s cubic-bezier(0.25, 1, 0.5, 1), box-shadow 0.2s; transform-origin: center center;`,
          title: `${dataStr.split('-').reverse().join('/')}: ${contagem} modificações`
        }
      });

      cell.addEventListener('mouseenter', () => { cell.style.transform = 'scale(1.3)'; cell.style.boxShadow = `0 0 6px ${corHex}`; cell.style.zIndex = '10'; });
      cell.addEventListener('mouseleave', () => { cell.style.transform = 'scale(1)'; cell.style.boxShadow = 'none'; cell.style.zIndex = 'auto'; });

      cell.addEventListener('click', () => {
        detailsContainer.empty();
        
        const formatData = dataStr.split('-').reverse().join('/');
        
        if (!diaData || diaData.files.length === 0) {
            const noDataWrapper = detailsContainer.createEl('div', { attr: { style: 'display: flex; justify-content: space-between; align-items: center; width: 100%;' } });
            noDataWrapper.createEl('div', { text: `Nenhuma modificação registrada em ${formatData}.`, attr: { style: 'color: #a3abcb; font-size: 12px; font-style: italic; padding: 4px 0;' } });
            
            const closeBtn = noDataWrapper.createEl('span', { text: '✕', attr: { style: 'cursor: pointer; color: #a3abcb; font-size: 14px; padding: 0 4px; font-weight: bold;' } });
            closeBtn.addEventListener('click', () => { detailsContainer.empty(); });
            return;
        }

        const listHeader = detailsContainer.createEl('div', { attr: { style: 'font-size: 12px; font-weight: 600; color: #cba6f7; margin-bottom: 8px; letter-spacing: 0.5px; display: flex; align-items: center; justify-content: space-between; width: 100%;' } });
        listHeader.createEl('div', { text: `📅 MODIFICAÇÕES EM ${formatData} (${diaData.files.length} notas/arquivos)`, attr: { style: 'display: flex; align-items: center; gap: 6px;' } });
        
        const closeBtn = listHeader.createEl('span', { text: '✕', attr: { style: 'cursor: pointer; color: #a3abcb; font-size: 14px; padding: 0 4px; font-weight: bold; transition: color 0.2s;' } });
        closeBtn.addEventListener('mouseenter', () => closeBtn.style.color = '#f38ba8');
        closeBtn.addEventListener('mouseleave', () => closeBtn.style.color = '#a3abcb');
        closeBtn.addEventListener('click', () => { detailsContainer.empty(); });

        const cardsWrapper = detailsContainer.createEl('div', { attr: { style: 'display: flex; flex-direction: column; gap: 6px;' } });

        diaData.files.forEach((f: GitFile) => {
          const card = cardsWrapper.createEl('div', { attr: { style: 'display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; border-radius: 6px; background: rgba(255,255,255,0.02); border: 1px solid var(--border-inner-button, #2a2a37);' } });
          
          const normalizedPath = normalizePath(f.path);
          let fileExists = false;
          let pathToOpen = f.path; 
          
          let abstractFile = this.app.vault.getAbstractFileByPath(normalizedPath);

          if (abstractFile) {
              fileExists = true;
              pathToOpen = abstractFile.path; 
          }

          let statusIcon = '📄';
          let statusText = '';
          let statusColor = '';
          let isStrikeThrough = false;
          let isUnclickable = false;

          if (!fileExists) {
              statusIcon = '🗑️';
              statusText = 'Apagado';
              statusColor = '#f38ba8'; 
              isStrikeThrough = true;
              isUnclickable = true;
          } else if (f.isRenamed) {
              statusIcon = '🚚';
              statusText = 'Renomeado';
              statusColor = '#89b4fa'; 
          } else if (f.added > 0 && f.deleted === 0) {
              statusIcon = '✨';
              statusText = 'Criado/Expandido';
              statusColor = '#a6e3a1'; 
          } else if (f.added === 0 && f.deleted > 0) {
              statusIcon = '🧹';
              statusText = 'Reduzido';
              statusColor = '#f9e2af'; 
          } else {
              statusIcon = '✏️';
              statusText = 'Editado';
              statusColor = '#cba6f7'; 
          }

          if (f.isSpecial && fileExists) {
              statusIcon = '📦';
              statusText = 'Binário/Movido';
              statusColor = '#9399b2'; 
          }

          const infoWrapper = card.createEl('div', { attr: { style: 'display: flex; align-items: center; gap: 8px;' } });

          const nameEl = infoWrapper.createEl(isUnclickable ? 'span' : 'a', { 
              text: `${statusIcon} ${f.name}`, 
              attr: { 
                  style: `color: ${isStrikeThrough ? '#6c7086' : 'var(--text-accent, #cba6f7)'}; text-decoration: ${isStrikeThrough ? 'line-through' : 'none'}; font-weight: 500; cursor: ${isUnclickable ? 'default' : 'pointer'}; font-size: 12px; display: inline-flex; align-items: center;`, 
                  title: fileExists ? pathToOpen : f.path 
              } 
          });

          if (!isUnclickable) {
              nameEl.addEventListener('click', () => { 
                const finalPath = pathToOpen.replace(/\.md$/i, '');
                this.app.workspace.openLinkText(finalPath, '', false); 
              });
          }

          infoWrapper.createEl('span', { 
              text: statusText, 
              attr: { style: `background: ${statusColor}1A; border: 1px solid ${statusColor}4D; color: ${statusColor}; padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: bold; letter-spacing: 0.5px; text-transform: uppercase;` } 
          });

          const counters = card.createEl('div', { attr: { style: 'font-size: 11px; font-family: monospace; font-weight: 600; display: flex; gap: 6px;' } });
          if (!f.isSpecial) {
              if (f.added > 0) counters.createEl('span', { text: `+${f.added}`, attr: { style: 'color: #a6e3a1;' } });
              if (f.deleted > 0) counters.createEl('span', { text: `-${f.deleted}`, attr: { style: 'color: #f38ba8;' } });
          }
        });
      });
    });

    const footer = pluginBox.createEl('div', { attr: { style: 'display: flex; justify-content: space-between; font-size: 11px; color: #a3abcb; padding-top: 12px; border-top: 1px solid var(--border-inner-button, #2a2a37); margin-top: 6px;' } });
    const totalFormatado = totalAnualDeContribuicoes.toLocaleString('pt-BR');
    footer.createEl('span', { text: `${totalFormatado} contribuições no último ano`, attr: { style: 'letter-spacing: 0.5px; font-weight: 600;' } });
    
    const legenda = footer.createEl('div', { attr: { style: 'display: flex; gap: 3px; align-items: center;' } });
    legenda.createEl('span', { text: 'Menos', attr: { style: 'margin-right: 4px; font-size: 10px;' } });
    coresTema.forEach(cor => legenda.createEl('div', { attr: { style: `width: 11px; height: 11px; background-color: ${cor}; border-radius: 2px;` } }));
    legenda.createEl('span', { text: 'Mais', attr: { style: 'margin-left: 4px; font-size: 10px;' } });

    container.empty();
    container.appendChild(pluginBox);
  }
}