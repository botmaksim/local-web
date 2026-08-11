const express = require('express');
const app = express();
app.use('/:ip', (req, res, next) => {
    console.log("ip from req.params:", req.params.ip);
    res.end(req.params.ip || "undefined");
});
app.listen(9092, () => console.log('test'));
