import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { open } from "@tauri-apps/api/dialog";
import "./index.css";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Settings, Activity, Folder, Database, HardDrive, Clock, Calendar } from 'lucide-react';

const DEFAULT_CHART_DATA = [
  { day: 'Seg', size: 45, time: 2 },
  { day: 'Ter', size: 47, time: 2.1 },
  { day: 'Qua', size: 48, time: 2.5 },
  { day: 'Qui', size: 50, time: 2.3 },
  { day: 'Sex', size: 55, time: 3 },
  { day: 'Sab', size: 56, time: 3.1 },
  { day: 'Dom', size: 60, time: 3.5 },
];

function App() {
  const [status, setStatus] = useState("Status: 🔴 SERVIDOR OFF — Aguardando conexão");
  const [config, setConfig] = useState({ host: "192.168.1.100", port: "5432", db: "hospital", user: "postgres", pass: "" });
  const [isConnected, setIsConnected] = useState(false);
  const [autoConnectEnabled, setAutoConnectEnabled] = useState(true);
  const [backupPath, setBackupPath] = useState("");
  const [schedule, setSchedule] = useState("24h");
  const [logs, setLogs] = useState<{date: string, time: string, msg: string, type: string}[]>([]);
  const [chartData, setChartData] = useState(DEFAULT_CHART_DATA);
  const [logFilterDate, setLogFilterDate] = useState("");
  const [dbTables, setDbTables] = useState<string[]>([]);
  const [selectedTableData, setSelectedTableData] = useState<{table: string, columns: string[], data: any[]}|null>(null);

  // INIT: Load from localStorage ("banco local embutido")
  useEffect(() => {
    const savedConfig = localStorage.getItem("axion_config");
    if (savedConfig) {
      const parsed = JSON.parse(savedConfig);
      setConfig(parsed.config);
      setBackupPath(parsed.backupPath);
      setSchedule(parsed.schedule);
    }
    
    const savedHistory = localStorage.getItem("axion_backup_history");
    if (savedHistory) setChartData(JSON.parse(savedHistory));

    const savedLogs = localStorage.getItem("axion_logs");
    if (savedLogs) {
      // Auto-cleanup logs older than 15 days locally
      const parsedLogs = JSON.parse(savedLogs);
      const fifteenDaysAgo = new Date();
      fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);
      
      const filteredLogs = parsedLogs.filter((log: any) => {
        const [day, month, year] = log.date.split('/');
        const logDate = new Date(`${year}-${month}-${day}`);
        return logDate >= fifteenDaysAgo;
      });
      setLogs(filteredLogs);
      localStorage.setItem("axion_logs", JSON.stringify(filteredLogs));
    }
  }, []);

  // Auto connect and retry mechanism
  useEffect(() => {
    if (!config.pass || isConnected || !autoConnectEnabled) return;

    // Tentar conectar imediatamente se ainda não estiver conectado
    testConnection();

    // Tentar reconectar a cada 5 segundos se falhar
    const interval = setInterval(() => {
      if (!isConnected && autoConnectEnabled) {
        testConnection();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [config.pass, isConnected, autoConnectEnabled]);

  const fetchTables = async () => {
    try {
      const tables = await invoke("get_database_tables", { ...config });
      if (Array.isArray(tables)) {
        setDbTables(tables);
      }
    } catch (err) {
      addLog("Erro ao listar tabelas do banco: " + err, "error");
    }
  };

  const openTablePreview = async (table: string) => {
    try {
      addLog(`Buscando dados da tabela: ${table}...`, "info");
      const jsonStr = await invoke("get_table_data", { ...config, table });
      if (typeof jsonStr === 'string') {
        const rows = JSON.parse(jsonStr);
        if (Array.isArray(rows) && rows.length > 0) {
          const columns = Object.keys(rows[0]);
          setSelectedTableData({ table, columns, data: rows });
          addLog(`Pré-visualização da tabela ${table} aberta com sucesso.`, "success");
        } else {
          addLog(`A tabela ${table} está vazia.`, "info");
        }
      }
    } catch (err) {
      addLog("Erro ao buscar dados da tabela: " + err, "error");
    }
  };

  useEffect(() => {
    if (isConnected) {
      addLog("Conexão com PostgreSQL estabelecida com sucesso.", "success");
      localStorage.setItem("axion_config", JSON.stringify({ config, backupPath, schedule }));
      fetchTables();
    }
  }, [isConnected]);

  function addLog(msg: string, type: string = "info") {
    const now = new Date();
    const time = now.toLocaleTimeString();
    const date = now.toLocaleDateString(); // DD/MM/YYYY
    setLogs(prev => {
      const newLogs = [...prev, { date, time, msg, type }];
      localStorage.setItem("axion_logs", JSON.stringify(newLogs));
      return newLogs;
    });
  }

  // Backup Engine Loop
  useEffect(() => {
    if (!isConnected || !backupPath || !schedule) return;

    let ms = 60000; // 1m
    if (schedule === "5m") ms = 5 * 60000;
    if (schedule === "10m") ms = 10 * 60000;
    if (schedule === "15m") ms = 15 * 60000;
    if (schedule === "1h") ms = 60 * 60000;
    if (schedule === "6h") ms = 6 * 3600000;
    if (schedule === "12h") ms = 12 * 3600000;
    if (schedule === "24h") ms = 24 * 3600000;

    const interval = setInterval(() => {
      addLog("Iniciando rotina de backup (pg_dump) em segundo plano...", "info");
      
      invoke("execute_backup", { ...config, dest: backupPath }).then((size) => {
        addLog(`Backup físico concluído com sucesso! (Tamanho real: ${Number(size).toFixed(2)}MB)`, "success");
        
        // Update Chart
        setChartData(prev => {
          const newData = [...prev.slice(1), { day: 'Hoje', size: Number(size).toFixed(1), time: 2.5 }];
          localStorage.setItem("axion_backup_history", JSON.stringify(newData));
          return newData;
        });

        // Limpeza de Backups (Deleta arquivos .sql mais velhos que 15 dias na pasta)
        invoke("cleanup_old_backups", { dest: backupPath, days: 15 }).then((deletedCount) => {
          if (deletedCount && Number(deletedCount) > 0) {
            addLog(`Limpeza automática: ${deletedCount} backup(s) antigo(s) (>15 dias) foram deletados do disco para poupar espaço.`, "info");
          }
        });

      }).catch(err => {
        addLog(`Falha no backup: ${err}`, "error");
      });

    }, ms);

    return () => clearInterval(interval);
  }, [isConnected, backupPath, schedule, config]);

  async function testConnection() {
    setStatus("Status: 🟡 Testando conexão...");
    try {
      const res = await invoke("test_connection", { ...config });
      if (res === "ok") {
        setStatus("Status: 🟢 SERVIDOR ON — PostgreSQL conectado");
        setIsConnected(true);
      } else {
        setStatus("Status: 🔴 SERVIDOR OFF — " + res);
        setIsConnected(false);
      }
    } catch (e) {
      setStatus("Status: 🔴 SERVIDOR OFF — " + e);
      setIsConnected(false);
    }
  }

  async function selectFolder() {
    try {
      const selectedPath = await open({
        directory: true,
        multiple: false,
        title: "Selecione a pasta para os backups"
      });
      if (selectedPath && typeof selectedPath === 'string') {
        setBackupPath(selectedPath);
        addLog(`Pasta configurada: ${selectedPath}`, "success");
        addLog("O serviço de backup automático está pronto.", "success");
      }
    } catch (e) {
      addLog("Erro ao abrir seletor: " + e, "error");
    }
  }

  // Filter logs by selected date (YYYY-MM-DD -> DD/MM/YYYY)
  const filteredLogs = logs.filter(log => {
    if (!logFilterDate) return true;
    const [year, month, day] = logFilterDate.split('-');
    return log.date === `${day}/${month}/${year}`;
  });

  function renderDashboard() {
    return (
      <>
      <div className="dashboard-grid">
        {/* Coluna Esquerda: Configurações */}
        <div className="col">
          <div className="card">
            <h2><Settings size={20} style={{verticalAlign: 'middle', marginRight: 8}}/> Configurações do Backup</h2>
            
            <label><Folder size={16} style={{verticalAlign: 'text-bottom'}}/> Destino dos Backups</label>
            <div className="path-selector">
              <input readOnly value={backupPath} placeholder="Nenhuma pasta selecionada..." />
              <button className="btn-folder" onClick={selectFolder}>
                Escolher
              </button>
            </div>

            <label><Clock size={16} style={{verticalAlign: 'text-bottom'}}/> Frequência</label>
            <select className="schedule-select" value={schedule} onChange={(e) => {
              setSchedule(e.target.value);
              addLog(`Intervalo de backup alterado para: a cada ${e.target.value}`, "info");
            }}>
              <option value="1m">A cada 1 Minuto</option>
              <option value="5m">A cada 5 Minutos</option>
              <option value="10m">A cada 10 Minutos</option>
              <option value="15m">A cada 15 Minutos</option>
              <option value="1h">A cada 1 Hora</option>
              <option value="6h">A cada 6 Horas</option>
              <option value="12h">A cada 12 Horas</option>
              <option value="24h">A cada 24 Horas (Diário)</option>
            </select>

            <div className="status-box on">
               {status}
            </div>

            <div className="buttons">
              <button className="btn-connect" onClick={() => {
                localStorage.setItem("axion_config", JSON.stringify({ config, backupPath, schedule }));
                addLog("As configurações foram enviadas e salvas no Banco Local!", "success");
              }}>Salvar Configuração</button>
              <button className="btn-test" onClick={() => {
                setAutoConnectEnabled(false);
                setIsConnected(false);
              }}>Desconectar</button>
              <button 
                className="btn-test" 
                style={{ flex: 0.4, borderColor: '#ef4444', color: '#ef4444', padding: '0.8rem' }}
                onClick={() => {
                  if(confirm("Tem certeza que deseja apagar todos os logs e configurações salvas?")) {
                    localStorage.clear();
                    window.location.reload();
                  }
                }} 
                title="Limpar Dados Locais"
              >
                Limpar
              </button>
            </div>
          </div>
        </div>

        {/* Coluna Direita: Gráficos e Logs */}
        <div className="col">
          <div className="card">
            <h2><Activity size={20} style={{verticalAlign: 'middle', marginRight: 8}}/> Desempenho (Últimos 7 dias)</h2>
            <div style={{ width: '100%', height: 160 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <XAxis dataKey="day" stroke="#a6adc8" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="#a6adc8" fontSize={12} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: '#181825', border: '1px solid #45475a', borderRadius: '8px' }} />
                  <Area type="monotone" dataKey="size" name="Tamanho (MB)" stroke="#89b4fa" fill="#89b4fa" fillOpacity={0.3} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="card">
            <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span><HardDrive size={20} style={{verticalAlign: 'middle', marginRight: 8}}/> Histórico de Ações</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.9rem' }}>
                <Calendar size={16} />
                <input 
                  type="date" 
                  value={logFilterDate} 
                  onChange={e => setLogFilterDate(e.target.value)} 
                  style={{ background: 'transparent', color: '#cdd6f4', border: 'none', padding: 0 }}
                  title="Filtrar logs por data"
                />
              </div>
            </h2>
            <div className="logs-container" style={{height: 140, overflowY: 'auto'}}>
              {filteredLogs.length > 0 ? filteredLogs.map((log, i) => (
                <div key={i} className={`log-line ${log.type}`}>
                  [{log.date} {log.time}] {log.msg}
                </div>
              )) : (
                <div className="log-line">Nenhum log encontrado para esta data.</div>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {/* Coluna Inferior: Estrutura do Banco de Dados */}
      {isConnected && (
        <div className="card" style={{ marginTop: '2rem' }}>
          <h2><Database size={20} style={{verticalAlign: 'middle', marginRight: 8}}/> Tabelas Inclusas no Backup (Estrutura do Banco)</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {dbTables.length > 0 ? dbTables.map(t => (
              <span key={t} className="table-badge" onClick={() => openTablePreview(t)} title="Clique para ver os dados">
                {t}
              </span>
            )) : <span style={{color: '#94a3b8'}}>Carregando tabelas ou banco de dados vazio...</span>}
          </div>
        </div>
      )}
      
      {/* Modal de Pré-visualização de Tabela */}
      {selectedTableData && (
        <div className="modal-overlay" onClick={(e) => {
          if (e.target === e.currentTarget) setSelectedTableData(null);
        }}>
          <div className="modal-content">
            <div className="modal-header">
              <h3><Database size={20} style={{verticalAlign: 'middle', marginRight: 8}}/> Pré-visualização: {selectedTableData.table}</h3>
              <button className="btn-close" onClick={() => setSelectedTableData(null)}>✖</button>
            </div>
            
            <div className="table-preview">
              <table>
                <thead>
                  <tr>
                    {selectedTableData.columns.map(col => (
                      <th key={col}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {selectedTableData.data.map((row, i) => (
                    <tr key={i}>
                      {selectedTableData.columns.map(col => (
                        <td key={col}>
                          {typeof row[col] === 'object' ? JSON.stringify(row[col]) : String(row[col])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
    );
  }

  return (
    <div className="container">
      <h1 className="title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '1rem' }}>
        <img src="https://upload.wikimedia.org/wikipedia/commons/2/29/Postgresql_elephant.svg" alt="PostgreSQL" width="40" height="40" />
        PostgreSQL Backup Manager
      </h1>
      {!isConnected ? (
        <div className="card">
          <h2>Conexão com o Servidor</h2>
          <label>Servidor (IP ou Hostname)</label>
          <input value={config.host} onChange={(e) => setConfig({ ...config, host: e.target.value })} placeholder="Ex: 192.168.1.100" />
          
          <label>Porta</label>
          <input value={config.port} onChange={(e) => setConfig({ ...config, port: e.target.value })} placeholder="Ex: 5432" />
          
          <label>Banco de dados</label>
          <input value={config.db} onChange={(e) => setConfig({ ...config, db: e.target.value })} placeholder="Ex: hospital" />
          
          <label>Usuário</label>
          <input value={config.user} onChange={(e) => setConfig({ ...config, user: e.target.value })} placeholder="Ex: postgres" />
          
          <label>Senha</label>
          <input type="password" value={config.pass} onChange={(e) => setConfig({ ...config, pass: e.target.value })} placeholder="********" />
          
          <div className="buttons">
            <button className="btn-test" onClick={() => {
              setAutoConnectEnabled(true);
              testConnection();
            }}>TESTAR CONEXÃO</button>
            <button className="btn-connect" disabled={!status.includes("ON")} onClick={() => {
              setAutoConnectEnabled(true);
              setIsConnected(true);
            }}>CONECTAR</button>
          </div>
          <div className="status-box">
            {status}
          </div>
        </div>
      ) : renderDashboard()}
      
      <div style={{ textAlign: 'center', marginTop: '2rem', color: '#a6adc8', fontSize: '0.9rem', paddingBottom: '1rem' }}>
        Desenvolvido por <strong>ALEF DIAS</strong>
      </div>
    </div>
  );
}

export default App;
