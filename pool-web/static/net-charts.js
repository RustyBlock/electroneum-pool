var lastTimeNetHistoryRequested = new Date(2018, 1, 1);

netChartContainerSelector = 'net-chart-container';
netBlocksChartContainerSelector = 'netblocks-chart-container';
netChartTitle = 'Net difficulty';
netBlocksTitle = 'Block timing (s)';
netChartUnits = null;
netBlocksChartUnits = 's';
netAverageTitle = 'Average';
var netChart = null;
var netBlocksChart = null;

function updateNetChart(data) {
    window.netChartData = [
        {
            name: netChartTitle,
            data: function() {
                var res = [], date = (new Date()).getTime() - 300000; // 5 minutes ago
                date -= data.networkDiff.length * 300000;
                data.networkDiff.forEach(function(itm) {
                    res.push([date, itm]);
                    date += 300000;	
                });
                return res;
            }()
        }];
    window.netChartData.push({
        name: netAverageTitle,
        data: calculateDataAverage(window.netChartData[0].data)
    });
    window.netChartBlocks = [
        {
            name: netBlocksTitle,
            data: function() {
                var res = [], date = (new Date()).getTime() - 300000; // 5 minutes ago
                date -= data.blockTimings.length * 300000;
                data.blockTimings.forEach(function(itm) {
                    res.push([date, itm]);
                    date += 300000;	
                });
                return res;
            }()
        }
    ];
    window.netChartBlocks.push({
        name: netAverageTitle,
        data: calculateDataAverage(window.netChartBlocks[0].data)
    });
    netChart = renderStatsChart(window.netChartData, netChart, netChartContainerSelector, netChartTitle, netChartUnits);
    netBlocksChart = renderStatsChart(window.netChartBlocks, netBlocksChart, netBlocksChartContainerSelector, netBlocksTitle, netBlocksChartUnits);    
}

dropDownSelectorCommon($("#netMenu li a"), $("#netSelectorText"), function() {
    $('.netChartOverlay').show();
    forceLoadStatCharts();
});

if(window.netChartData) {
    netChart = renderStatsChart(window.netChartData, netChart, netChartContainerSelector, netChartTitle, netChartUnits);
    renderedAnyChart = true;
}
if(window.netChartBlocks) {
    netBlocksChart = renderStatsChart(window.netChartBlocks, netBlocksChart, netBlocksChartContainerSelector, netBlocksTitle, netBlocksChartUnits);
    renderedAnyChart = true;
}
