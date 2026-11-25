import app from './src/app.js';
import { startIdleReaper } from './src/routes/sandbox.routes.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Sandbox server is running on port ${PORT}`);
    startIdleReaper();
});