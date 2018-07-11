lastTimePoolHistoryRequested = new Date(2018, 1, 1);

poolChartContainerSelector = 'pool-chart-container';
poolMinersChartContainerSelector = 'poolminers-chart-container';
poolMinersTitle = 'Miners';
poolChartTitle = 'Hash rate (kH/s)';
poolChartUnits = 'kH/s';
poolMinersChartUnits = 'conn.';
poolAverageTitle = 'Average';
poolChart = null;
poolMinersChart = null;

function updatePoolChart(data) {

    window.poolChartData = [
        {
            name: 'Pool speed',
            data: function() {
                var res = [], date = (new Date()).getTime() - 300000; // 5 minutes ago
                date -= data.poolHashrate.length * 300000;
                data.poolHashrate.forEach(function(itm) {
                    res.push([date, itm / 1000]);
                    date += 300000;	
                });
                return res;
            }()
        }];
    window.poolChartData.push({
        name: poolAverageTitle,
        data: calculateDataAverage(window.poolChartData[0].data)
    });
    window.poolChartMinersData = [
        {
            name: 'Pool miners',
            data: function() {
                var res = [], date = (new Date()).getTime() - 300000; // 5 minutes ago
                date -= data.poolMiners.length * 300000;
                data.poolMiners.forEach(function(itm) {
                    res.push([date, itm]);
                    date += 300000;	
                });
                return res;
            }()
        }
    ];
    window.poolChartMinersData.push({
        name: poolAverageTitle,
        data: calculateDataAverage(window.poolChartMinersData[0].data)
    });
    poolChart = renderStatsChart(window.poolChartData, poolChart, poolChartContainerSelector, poolChartTitle, poolChartUnits);
    poolMinersChart = renderStatsChart(window.poolChartMinersData, poolMinersChart , poolMinersChartContainerSelector, poolMinersTitle, poolMinersChartUnits);
}

dropDownSelectorCommon($("#poolMenu li a"), $("#poolSelectorText"), function() {
    $('.poolChartOverlay').show();
    forceLoadStatCharts();
});

if(window.poolChartData) {
    poolChart = renderStatsChart(window.poolChartData, poolChart, poolChartContainerSelector, poolChartTitle, poolChartUnits);
    renderedAnyChart = true;
}
if(window.poolChartMinersData) {
    poolMinersChart = renderStatsChart(window.poolChartMinersData, poolMinersChart, poolMinersChartContainerSelector, poolMinersTitle, poolMinersChartUnits);
    renderedAnyChart = true;
}
