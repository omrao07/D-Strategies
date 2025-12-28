import { Request, Response } from "express"

const fetchNews = async (req: Request, res: Response) => {
  res.json({
    success: true,
    data: [],
  })
}

export default {
  fetchNews,
}