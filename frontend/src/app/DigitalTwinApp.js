import { SortingScene } from '../scene/SortingScene.js';
import { WSMessageGateway } from '../ws/WSMessageGateway.js';

export class DigitalTwinApp {
  constructor(container) {
    this.container = container;
    this.scene = null;
    this.wsGateway = null;
    this.packagesData = [];
    this.chutesData = [];
    this.conveyorSpeed = 2;
    this.selectedChute = null;

    this.stats = {
      totalPackages: 0,
      sortedToday: 0,
      faultChutes: 0,
      efficiency: 98.5
    };

    this.init();
  }

  init() {
    this.scene = new SortingScene(this.container);
    this.scene.onChuteClick = (chuteData) => this.handleChuteClick(chuteData);

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;

    this.wsGateway = new WSMessageGateway(wsUrl);

    this.setupWSHandlers();
    this.setupUI();

    this.wsGateway.connect().catch(err => {
      console.error('Failed to connect to WebSocket:', err);
      this.showConnectionError();
    });
  }

  setupWSHandlers() {
    this.wsGateway.on('scene_init', (data) => {
      console.log('Scene init:', data);
      this.handleSceneInit(data);
    });

    this.wsGateway.on('package_update', (packages) => {
      this.handlePackageUpdate(packages);
    });

    this.wsGateway.on('chute_status', (chutes) => {
      this.handleChuteStatusUpdate(chutes);
    });

    this.wsGateway.on('conveyor_speed', (data) => {
      this.conveyorSpeed = data.speed;
      this.scene.setConveyorSpeed(data.speed);
    });

    this.wsGateway.on('funnel_stats', (stats) => {
      this.handleFunnelStats(stats);
    });

    this.wsGateway.onConnect = () => {
      this.updateConnectionStatus(true);
    };

    this.wsGateway.onDisconnect = () => {
      this.updateConnectionStatus(false);
    };
  }

  setupUI() {
    this.createInfoPanel();
    this.createFunnelPanel();
    this.createControlPanel();
    this.createStatsPanel();
  }

  createInfoPanel() {
    const panel = document.createElement('div');
    panel.id = 'info-panel';
    panel.className = 'info-panel';
    panel.innerHTML = `
      <div class="panel-header">
        <h2>智慧物流分拣数字孪生系统</h2>
        <div class="connection-status" id="connection-status">
          <span class="status-dot"></span>
          <span class="status-text">连接中...</span>
        </div>
      </div>
      <div class="panel-body">
        <div class="info-item">
          <span class="label">系统状态</span>
          <span class="value" id="system-status">运行中</span>
        </div>
        <div class="info-item">
          <span class="label">传送带速度</span>
          <span class="value" id="conveyor-speed-display">2.0 m/s</span>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
  }

  createFunnelPanel() {
    const panel = document.createElement('div');
    panel.id = 'funnel-panel';
    panel.className = 'funnel-panel';
    panel.innerHTML = `
      <div class="panel-header">
        <h3>📊 效能漏斗图</h3>
        <button class="reset-btn" id="funnel-reset">重置</button>
      </div>
      <div class="funnel-chart" id="funnel-chart"></div>
      <div class="funnel-stats-grid" id="funnel-stats"></div>
      <div class="funnel-limits">
        <div class="funnel-limits-title">滑道限制</div>
        <div class="funnel-limits-row">
          <span>宽×高×深</span>
          <span>1.0 × 0.6 × 0.8 m</span>
        </div>
        <div class="funnel-limits-row">
          <span>最大体积</span>
          <span>0.48 m³</span>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    document.getElementById('funnel-reset').addEventListener('click', () => {
      this.wsGateway.sendControl('reset_stats');
    });

    this.funnelData = {
      total_entered: 0,
      scanned: 0,
      oversized_blocked: 0,
      sorting: 0,
      delivered: 0,
      failed: 0,
      intercept_rate: 0,
      success_rate: 0,
      error_rate: 0
    };
    this.updateFunnelChart();
  }

  handleFunnelStats(stats) {
    this.funnelData = { ...this.funnelData, ...stats };
    this.updateFunnelChart();
    this.updateEfficiencyStat();
  }

  updateFunnelChart() {
    const chart = document.getElementById('funnel-chart');
    if (!chart) return;

    const stages = [
      { key: 'total_entered', label: '进入', cls: 'entering', pctCls: 'info' },
      { key: 'scanned', label: '扫描', cls: 'scanned', pctCls: 'success' },
      { key: 'oversized_blocked', label: '超规', cls: 'oversized', pctCls: 'warning' },
      { key: 'sorting', label: '分拣', cls: 'sorting', pctCls: 'info' },
      { key: 'delivered', label: '投递', cls: 'delivered', pctCls: 'success' },
      { key: 'failed', label: '失败', cls: 'failed', pctCls: 'danger' }
    ];

    const maxCount = Math.max(this.funnelData.total_entered, 1);

    chart.innerHTML = stages.map(stage => {
      const count = this.funnelData[stage.key] || 0;
      const width = maxCount > 0 ? (count / maxCount) * 100 : 0;
      const pct = this.funnelData.total_entered > 0
        ? ((count / this.funnelData.total_entered) * 100).toFixed(1)
        : '0.0';

      return `
        <div class="funnel-stage">
          <span class="funnel-label">${stage.label}</span>
          <div class="funnel-bar-wrapper">
            <div class="funnel-bar ${stage.cls}" style="width: ${Math.max(width, 2)}%">
              <span class="bar-count">${count}</span>
            </div>
          </div>
          <span class="funnel-percent ${stage.pctCls}">${pct}%</span>
        </div>
      `;
    }).join('');

    const statsGrid = document.getElementById('funnel-stats');
    if (statsGrid) {
      statsGrid.innerHTML = `
        <div class="funnel-stat">
          <div class="stat-value cyan">${this.funnelData.total_entered || 0}</div>
          <div class="stat-label">总进入量</div>
        </div>
        <div class="funnel-stat">
          <div class="stat-value green">${this.funnelData.delivered || 0}</div>
          <div class="stat-label">成功投递</div>
        </div>
        <div class="funnel-stat">
          <div class="stat-value orange">${(this.funnelData.intercept_rate || 0).toFixed(1)}%</div>
          <div class="stat-label">超规拦截率</div>
        </div>
        <div class="funnel-stat">
          <div class="stat-value red">${(this.funnelData.error_rate || 0).toFixed(1)}%</div>
          <div class="stat-label">失败率</div>
        </div>
      `;
    }
  }

  updateEfficiencyStat() {
    const effEl = document.getElementById('stat-efficiency');
    if (effEl) {
      const rate = this.funnelData.success_rate || 0;
      effEl.textContent = rate.toFixed(1) + '%';
    }
  }

  createControlPanel() {
    const panel = document.createElement('div');
    panel.id = 'control-panel';
    panel.className = 'control-panel';
    panel.innerHTML = `
      <div class="panel-header">
        <h3>控制面板</h3>
      </div>
      <div class="panel-body">
        <div class="control-group">
          <label>传送带速度</label>
          <div class="speed-control">
            <input type="range" id="speed-slider" min="0.5" max="5" step="0.1" value="2">
            <span id="speed-value">2.0</span>
          </div>
        </div>
        <div class="control-group">
          <label>分拣滑道状态</label>
          <div id="chute-list" class="chute-list"></div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    const speedSlider = document.getElementById('speed-slider');
    const speedValue = document.getElementById('speed-value');

    speedSlider.addEventListener('input', (e) => {
      const speed = parseFloat(e.target.value);
      speedValue.textContent = speed.toFixed(1);
    });

    speedSlider.addEventListener('change', (e) => {
      const speed = parseFloat(e.target.value);
      this.wsGateway.setConveyorSpeed(speed);
    });
  }

  createStatsPanel() {
    const panel = document.createElement('div');
    panel.id = 'stats-panel';
    panel.className = 'stats-panel';
    panel.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">📦</div>
          <div class="stat-info">
            <div class="stat-value" id="stat-packages">0</div>
            <div class="stat-label">在途包裹</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">✅</div>
          <div class="stat-info">
            <div class="stat-value" id="stat-sorted">0</div>
            <div class="stat-label">今日分拣</div>
          </div>
        </div>
        <div class="stat-card warning">
          <div class="stat-icon">⚠️</div>
          <div class="stat-info">
            <div class="stat-value" id="stat-faults">0</div>
            <div class="stat-label">故障滑道</div>
          </div>
        </div>
        <div class="stat-card success">
          <div class="stat-icon">📊</div>
          <div class="stat-info">
            <div class="stat-value" id="stat-efficiency">98.5%</div>
            <div class="stat-label">分拣效率</div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
  }

  handleSceneInit(data) {
    if (data.chutes) {
      this.chutesData = data.chutes;
      for (const chute of data.chutes) {
        this.scene.createChute(chute);
      }
      this.updateChuteList();
      this.updateFaultCount();
    }

    if (data.conveyor_length) {
      console.log('Conveyor length:', data.conveyor_length);
    }

    if (data.conveyor_speed) {
      this.conveyorSpeed = data.conveyor_speed;
      this.scene.setConveyorSpeed(data.conveyor_speed);
      document.getElementById('speed-slider').value = data.conveyor_speed;
      document.getElementById('speed-value').textContent = data.conveyor_speed.toFixed(1);
    }
  }

  handlePackageUpdate(packages) {
    this.packagesData = packages;
    this.scene.updateAllPackages(packages);
    this.updateStats();
  }

  handleChuteStatusUpdate(chutes) {
    this.chutesData = chutes;
    for (const chute of chutes) {
      this.scene.updateChuteStatus(chute.id, chute.status);
    }
    this.updateChuteList();
    this.updateFaultCount();
  }

  handleChuteClick(chuteData) {
    console.log('Chute clicked:', chuteData);
    this.selectedChute = chuteData;

    const currentStatus = chuteData.status;
    let nextStatus;

    switch (currentStatus) {
      case 'normal':
        nextStatus = 'maintenance';
        break;
      case 'maintenance':
        nextStatus = 'fault';
        break;
      case 'fault':
      default:
        nextStatus = 'normal';
        break;
    }

    if (confirm(`确定要将 "${chuteData.name}" 状态改为 ${this.getStatusLabel(nextStatus)} 吗？`)) {
      this.wsGateway.setChuteStatus(chuteData.id, nextStatus);
    }
  }

  getStatusLabel(status) {
    const labels = {
      normal: '正常运行',
      maintenance: '维护中',
      fault: '故障'
    };
    return labels[status] || status;
  }

  getStatusClass(status) {
    const classes = {
      normal: 'status-normal',
      maintenance: 'status-maintenance',
      fault: 'status-fault'
    };
    return classes[status] || '';
  }

  updateChuteList() {
    const chuteList = document.getElementById('chute-list');
    if (!chuteList) return;

    chuteList.innerHTML = this.chutesData
      .sort((a, b) => a.index - b.index)
      .map(chute => `
        <div class="chute-item ${this.getStatusClass(chute.status)}" data-id="${chute.id}">
          <span class="chute-name">${chute.name}</span>
          <span class="chute-status">${this.getStatusLabel(chute.status)}</span>
        </div>
      `).join('');

    chuteList.querySelectorAll('.chute-item').forEach(item => {
      item.addEventListener('click', () => {
        const chuteId = item.dataset.id;
        const chute = this.chutesData.find(c => c.id === chuteId);
        if (chute) {
          this.handleChuteClick(chute);
        }
      });
    });
  }

  updateStats() {
    const packagesCount = this.packagesData.length;
    document.getElementById('stat-packages').textContent = packagesCount;

    const sortedCount = this.stats.sortedToday + Math.floor(packagesCount * 0.3);
    document.getElementById('stat-sorted').textContent = sortedCount;
  }

  updateFaultCount() {
    const faultCount = this.chutesData.filter(c => c.status !== 'normal').length;
    document.getElementById('stat-faults').textContent = faultCount;
  }

  updateConnectionStatus(connected) {
    const statusDot = document.querySelector('#connection-status .status-dot');
    const statusText = document.querySelector('#connection-status .status-text');

    if (connected) {
      statusDot.className = 'status-dot connected';
      statusText.textContent = '已连接';
    } else {
      statusDot.className = 'status-dot disconnected';
      statusText.textContent = '已断开';
    }
  }

  showConnectionError() {
    console.log('Connection error - running in demo mode');
  }

  destroy() {
    if (this.scene) {
      this.scene.dispose();
    }
    if (this.wsGateway) {
      this.wsGateway.disconnect();
    }
  }
}
