import { Router } from "express"
import newsController from "../controllers/news.controller"

const router = Router()

router.get("/", newsController.fetchNews)

export default router